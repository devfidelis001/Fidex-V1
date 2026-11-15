"""FIDEX Eye: input -> Eye -> output. Nothing else.

No Electron, no Python bridge, no brain/memory/history layer. The window talks straight to the local Ollama model
(the Eye), over one kept-alive connection, and prints every token the moment it arrives.

    python fidex_eye.py

Optional environment: FIDEX_OLLAMA_HOST (default http://127.0.0.1:11434), FIDEX_OLLAMA_MODEL (default qwen3.5:4b).
Only the standard library is required; Pillow (already installed with PyAutoGUI) is used for fast image preparation.
"""
from __future__ import annotations

import base64
import http.client
import io
import json
import os
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse

HOST = os.environ.get("FIDEX_OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("FIDEX_OLLAMA_MODEL", "qwen3.5:4b")
KEEP_ALIVE = "60m"  # the model stays loaded between questions
OPTIONS = {"num_ctx": 2048, "num_predict": -1, "temperature": 0.4, "top_k": 20, "top_p": 0.85}  # one question + one image: a small context is faster
SYSTEM = "You are the eye of FIDEX AI. Look at the image (if any) and answer the user's question directly and briefly. Read text and numbers exactly. Never invent what you cannot see. Reply in the user's language, plain text."
ORDINARY_PX, DETAIL_PX, DETAIL_EDGE = 512, 1024, 0.015  # 512 px normally; 1024 px when fine text / small detail would be lost


# ---------------- Ollama itself: started automatically when it is not running ----------------
SPEED_ENV = {"OLLAMA_FLASH_ATTENTION": "1", "OLLAMA_KV_CACHE_TYPE": "q8_0", "OLLAMA_KEEP_ALIVE": KEEP_ALIVE, "OLLAMA_NUM_PARALLEL": "1", "OLLAMA_MAX_LOADED_MODELS": "1"}


def _up(timeout: float = 1.0) -> bool:
    u = urllib.parse.urlparse(HOST)
    try:
        with socket.create_connection((u.hostname or "127.0.0.1", u.port or 11434), timeout=timeout):
            return True
    except OSError:
        return False


def _ollama_exe() -> str | None:
    exe = os.environ.get("FIDEX_OLLAMA_EXE") or shutil.which("ollama")
    if exe:
        return exe
    for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles")):
        path = os.path.join(base or "", "Programs", "Ollama", "ollama.exe") if base == os.environ.get("LOCALAPPDATA") else os.path.join(base or "", "Ollama", "ollama.exe")
        if base and os.path.isfile(path):
            return path
    return None


_start_lock = threading.Lock()


def ensure_ollama(wait: float = 40.0) -> None:
    """Returns when Ollama answers. If it is not running it is started here (hidden, with the speed settings) and awaited.
    Raises RuntimeError with the exact reason when that is impossible."""
    if _up():
        return
    with _start_lock:
        if _up():
            return
        exe = _ollama_exe()
        if not exe:
            raise RuntimeError("Ollama is not installed (or not found). Install it from ollama.com, then try again.")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        try:
            subprocess.Popen([exe, "serve"], env={**os.environ, **SPEED_ENV}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        except OSError as err:
            raise RuntimeError(f"Could not start Ollama ({err}).") from None
        end = time.time() + wait
        while time.time() < end:
            if _up():
                return
            time.sleep(0.1)
        raise RuntimeError(f"Ollama was started but did not answer within {wait:.0f} s.")


# ---------------- image preparation (once, no repeated conversions) ----------------
def prepare(data: bytes) -> bytes:
    """Smallest image that still keeps the detail. Returns JPEG bytes (the original bytes when nothing needed changing)."""
    try:
        from PIL import Image, ImageChops, ImageOps  # noqa: PLC0415
    except ImportError:
        return data
    img = Image.open(io.BytesIO(data))
    was_jpeg = img.format == "JPEG"
    if was_jpeg:
        img.draft("RGB", (DETAIL_PX * 2, DETAIL_PX * 2))  # the JPEG decoder itself decodes at reduced size: much faster for photos
    img = ImageOps.exif_transpose(img)
    big = max(img.size)
    if big <= ORDINARY_PX and was_jpeg:
        return data
    grey = img.convert("L").reduce(2) if big > 600 else img.convert("L")
    total = grey.width * grey.height
    edge = 0.0
    for dx, dy in ((1, 0), (0, 1)):
        hist = ImageChops.difference(grey, ImageChops.offset(grey, dx, dy)).histogram()
        edge += sum(hist[41:]) / total / 2
    detail = edge >= DETAIL_EDGE  # text, screenshots, documents, small objects
    limit = DETAIL_PX if detail else ORDINARY_PX
    if big > limit:
        k = limit / big
        img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS if detail else Image.BILINEAR, reducing_gap=2.0)
    elif was_jpeg:
        return data
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=85 if detail else 72)
    return buf.getvalue()


# ---------------- the Eye: one direct, kept-alive connection to the model ----------------
class Eye:
    def __init__(self) -> None:
        self.ready = threading.Event()
        self.error = ""
        self._conn: http.client.HTTPConnection | None = None
        self._busy = threading.Lock()
        self._stop = threading.Event()

    def _connect(self) -> http.client.HTTPConnection:
        u = urllib.parse.urlparse(HOST)
        conn = http.client.HTTPConnection(u.hostname or "127.0.0.1", u.port or 11434, timeout=None)
        conn.connect()
        conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)  # tokens leave the socket at once
        return conn

    def _open(self, body: dict) -> http.client.HTTPResponse:
        payload = json.dumps(body)
        for attempt in (1, 2):  # a kept-alive connection can have been closed by the server: reconnect once
            try:
                if self._conn is None:
                    self._conn = self._connect()
                self._conn.request("POST", "/api/chat", payload, {"Content-Type": "application/json"})
                return self._conn.getresponse()
            except (OSError, http.client.HTTPException):
                self._drop()
                if attempt == 2 or self._stop.is_set():
                    raise

    def _drop(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                if conn.sock is not None:
                    conn.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()

    def warmup(self) -> None:
        """At launch, in the background: loads the model AND its image encoder (tiny image), so the first real picture waits for nothing."""
        t0 = time.time()
        try:
            ensure_ollama()
            tiny = None
            try:
                from PIL import Image  # noqa: PLC0415

                b = io.BytesIO()
                Image.new("RGB", (64, 64), (128, 128, 128)).save(b, "JPEG")
                tiny = base64.b64encode(b.getvalue()).decode()
            except ImportError:
                pass
            msg = {"role": "user", "content": "ok", **({"images": [tiny]} if tiny else {})}
            with self._busy:
                resp = self._open({"model": MODEL, "messages": [msg], "stream": False, "think": False, "keep_alive": KEEP_ALIVE, "options": {**OPTIONS, "num_predict": 1}})
                body = resp.read()
            if resp.status != 200:
                raise RuntimeError(_error_text(resp.status, body))
            self.error = ""
            self.ready.set()
            self.warm_ms = round((time.time() - t0) * 1000)
        except Exception as err:  # noqa: BLE001
            self.error = _friendly(err)

    def stop(self) -> None:
        self._stop.set()
        self._drop()  # closing the socket makes Ollama stop generating

    def look(self, question: str, image: bytes | None, on_token) -> dict:
        """Ask the Eye. Every visible piece goes to on_token immediately. Returns timings. Raises RuntimeError with a plain message."""
        self._stop.set()  # a still-running older answer ends at once
        with self._busy:
            self._stop.clear()
            t0 = time.time()
            msg = {"role": "user", "content": question or "What is in this image?"}
            if image:
                msg["images"] = [base64.b64encode(prepare(image)).decode()]
            prep_ms = round((time.time() - t0) * 1000)
            body = {"model": MODEL, "messages": [{"role": "system", "content": SYSTEM}, msg], "stream": True, "think": False, "keep_alive": KEEP_ALIVE, "options": OPTIONS}
            first = None
            try:
                if not _up():  # Ollama stopped since launch: start it again instead of failing
                    self._drop()
                    ensure_ollama()
                resp = self._open(body)
                if resp.status != 200:
                    raise RuntimeError(_error_text(resp.status, resp.read()))
                started = False
                while not self._stop.is_set():
                    line = resp.readline()
                    if not line:
                        break
                    obj = json.loads(line)
                    if obj.get("error"):
                        raise RuntimeError(str(obj["error"]))
                    piece = (obj.get("message") or {}).get("content") or ""
                    if piece:
                        if not started:
                            piece, started = piece.lstrip(), True
                            first = round((time.time() - t0) * 1000)
                        if piece:
                            on_token(piece)
                    if obj.get("done"):
                        resp.read()  # leaves the connection clean for the next question
                        break
                if self._stop.is_set():
                    self._drop()
            except (OSError, http.client.HTTPException) as err:
                if not self._stop.is_set():
                    self._drop()
                    raise RuntimeError(_friendly(err)) from None
            return {"prepare_ms": prep_ms, "first_token_ms": first, "total_ms": round((time.time() - t0) * 1000)}


def _error_text(status: int, body: bytes) -> str:
    try:
        detail = json.loads(body).get("error", "")
    except Exception:  # noqa: BLE001
        detail = ""
    if status == 404:
        return f"The model '{MODEL}' is not installed. Run:  ollama pull {MODEL}"
    return f"The model returned an error ({status}). {detail}".strip()


def _friendly(err: Exception) -> str:
    if isinstance(err, (ConnectionError, socket.timeout, http.client.HTTPException, OSError)) and not isinstance(err, RuntimeError):
        return "Cannot reach Ollama. Start Ollama and try again."
    return str(err)


# ---------------- the window: input, eye, output ----------------
def main() -> None:
    import tkinter as tk  # noqa: PLC0415
    from tkinter import filedialog  # noqa: PLC0415

    eye = Eye()
    threading.Thread(target=eye.warmup, name="eye-warmup", daemon=True).start()  # starts loading before the window even appears

    root = tk.Tk()
    root.title("FIDEX Eye - warming up...")
    root.geometry("820x640")
    root.configure(bg="#000000")
    out = tk.Text(root, wrap="word", bg="#000000", fg="#ffffff", insertbackground="#ffffff", relief="flat", font=("Segoe UI", 12), padx=14, pady=12, state="disabled")
    out.pack(fill="both", expand=True)
    row = tk.Frame(root, bg="#111111")
    row.pack(fill="x")
    box = tk.Text(row, height=3, wrap="word", bg="#111111", fg="#ffffff", insertbackground="#ffffff", relief="flat", font=("Segoe UI", 12), padx=10, pady=8)
    attach = tk.Button(row, text="Image", relief="flat", bg="#222222", fg="#ffffff")
    send = tk.Button(row, text="Send", relief="flat", bg="#ffffff", fg="#000000", width=7)
    box.pack(side="left", fill="both", expand=True)
    attach.pack(side="left", padx=4, pady=8)
    send.pack(side="left", padx=(0, 8), pady=8)

    tokens: queue.Queue = queue.Queue()
    state = {"image": None, "busy": False}

    def pump() -> None:  # tokens reach the screen within ~10 ms of arriving
        try:
            while True:
                kind, value = tokens.get_nowait()
                if kind == "t":
                    out.configure(state="normal")
                    out.insert("end", value)
                    out.see("end")
                    out.configure(state="disabled")
                elif kind == "done":
                    state["busy"] = False
                    send.configure(text="Send")
                    if value:
                        root.title(f"FIDEX Eye - first token {value['first_token_ms']} ms, total {value['total_ms'] / 1000:.1f} s (image prep {value['prepare_ms']} ms)")
                elif kind == "err":
                    state["busy"] = False
                    send.configure(text="Send")
                    out.configure(state="normal")
                    out.insert("end", f"\n[{value}]\n")
                    out.configure(state="disabled")
        except queue.Empty:
            pass
        if eye.ready.is_set() and root.title().endswith("warming up..."):
            root.title("FIDEX Eye - ready")
        elif eye.error and root.title().endswith("warming up..."):
            root.title("FIDEX Eye - " + eye.error)
        root.after(10, pump)

    def set_image(data: bytes | None, name: str = "") -> None:
        state["image"] = data
        attach.configure(text=("Image: " + name[:14] + " x") if data else "Image")

    def choose() -> None:
        if state["image"]:
            return set_image(None)
        path = filedialog.askopenfilename(filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp *.gif"), ("All files", "*.*")])
        if path:
            with open(path, "rb") as fh:
                set_image(fh.read(), os.path.basename(path))

    def paste(_e=None):  # Ctrl+V with an image or a copied file on the clipboard attaches it
        try:
            from PIL import ImageGrab  # noqa: PLC0415

            clip = ImageGrab.grabclipboard()
        except Exception:  # noqa: BLE001
            return None
        if clip is None:
            return None
        if isinstance(clip, list):
            with open(clip[0], "rb") as fh:
                set_image(fh.read(), os.path.basename(clip[0]))
        else:
            b = io.BytesIO()
            clip.save(b, "PNG")
            set_image(b.getvalue(), "pasted")
        return "break"

    def go(_e=None):
        if state["busy"]:
            eye.stop()  # Send turns into Stop while answering
            return "break"
        question, image = box.get("1.0", "end").strip(), state["image"]
        if not question and not image:
            return "break"
        box.delete("1.0", "end")
        set_image(None)
        state["busy"] = True
        send.configure(text="Stop")
        out.configure(state="normal")
        out.delete("1.0", "end")
        out.configure(state="disabled")

        def work() -> None:
            try:
                tokens.put(("done", eye.look(question, image, lambda t: tokens.put(("t", t)))))
            except Exception as err:  # noqa: BLE001
                tokens.put(("err", str(err)))

        threading.Thread(target=work, name="eye-look", daemon=True).start()
        return "break"

    attach.configure(command=choose)
    send.configure(command=go)
    box.bind("<Return>", lambda e: go() if not (e.state & 0x1) else None)  # Enter sends, Shift+Enter makes a new line
    box.bind("<Control-v>", lambda e: paste())
    box.focus_set()
    pump()
    root.mainloop()


if __name__ == "__main__":
    main()
