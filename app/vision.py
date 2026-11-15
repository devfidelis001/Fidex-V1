"""Live Desktop Vision: DXcam watches the Windows screen continuously, Ollama (the SAME local model, qwen3.5:4b) understands it.

    start() / pause() / resume() / stop() / status()   controls (one capture thread, started only by start())
    context()                                          one short text block with what is on screen NOW ("" when vision is off/stale)
    yield_to_brain()                                   cancels a vision analysis in flight so planning/chat never waits for it

How it stays fast and light
  * Capture: dxcam.grab() returns None when the screen did not change, so an idle desktop costs almost nothing.
  * A frame is analysed only when it really changed (64x36 grey thumbnail difference) and at most every MIN_GAP seconds;
    an unchanged screen is re-checked every HEARTBEAT seconds. The image sent to the model is downscaled to MAX_WIDTH.
  * Ollama is only used when the brain is idle (ai._gen_lock is taken without waiting); if planning or chat starts, the vision
    request is cancelled at once. Vision never delays a task.
Privacy: frames live only in memory, are never written to disk and only go to the local Ollama at 127.0.0.1.
Errors: missing DXcam, no screen, capture failures (camera is re-created), Ollama down or model missing: each is reported in
status()["error"] with the exact fix; transient ones retry with back-off, the controls keep working.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import re
import sys
import threading
import time
import uuid
from typing import Callable

from . import ai
from .protocol import RequestError

log = logging.getLogger("fidex.vision")

VISION_UNAVAILABLE = "VISION_UNAVAILABLE"
MAX_WIDTH = int(os.environ.get("FIDEX_VISION_WIDTH", "512"))  # pixels sent to the model (smaller = faster)
MIN_GAP = float(os.environ.get("FIDEX_VISION_MIN_GAP", "6.0"))  # seconds between two analyses, at the fastest
HEARTBEAT = float(os.environ.get("FIDEX_VISION_HEARTBEAT", "120"))  # re-analyse an unchanged screen this often
CHANGE_THRESHOLD = 2.0  # mean grey difference (0-255) of the thumbnails that counts as "the screen changed"
VISION_TOKENS = 60  # the description is short on purpose: it is generated in a few seconds
FRESH_FOR = 45.0  # context() is offered to the planner while the last confirmed look is younger than this
VISION_MODEL = os.environ.get("FIDEX_VISION_MODEL") or None  # optional override; default = the same qwen3.5:4b (no new download)

PROMPT = (
    "You are the eyes of a Windows assistant. Describe this screenshot in at most 30 words, plain text, no markdown: "
    "the active window/app and its title, other visible windows, any dialog/error/popup, the key visible text, and the main "
    "clickable things with their rough place (left/centre/right, top/middle/bottom). Say what the user seems to be doing. "
    "Never invent text you cannot read."
)

_lock = threading.RLock()
_thread: threading.Thread | None = None
_stop = threading.Event()
_running = threading.Event()  # set = capturing; cleared = paused
_emit: Callable[[str, object], object] | None = None
_inflight: str = ""  # id of the Ollama stream being used for vision right now
_force_pil = False  # DXcam cannot grab here (for example OpenCV/cv2 missing): use Pillow capture
_capture_name = ""  # "dxcam" or "pillow": what is capturing right now
_manual_off = False  # the user pressed Stop: tasks must not switch vision on again until the user starts it
_auto = False  # vision was switched on by a task (not by the user): it switches itself off when idle
_touch = 0.0  # last time a task used vision
_last_frame = None  # newest captured frame (memory only)
AUTO_IDLE = float(os.environ.get("FIDEX_VISION_AUTO_IDLE", "0"))  # seconds without a task before an automatic session ends

_S: dict = {}


def _reset() -> None:
    _S.clear()
    _S.update(state="stopped", error=None, summary="", summary_ts=0.0, seen_ts=0.0, frames=0, analysed=0, skipped_busy=0, capture_errors=0,
              ai_errors=0, fps=0.0, last_ms=0, screen=None, started=0.0, history=[], stale=True)


_reset()


def set_emitter(fn: Callable[[str, object], object] | None) -> None:
    global _emit
    _emit = fn


def _notify() -> None:
    if _emit is not None:
        try:
            _emit("vision.update", status())
        except Exception:  # noqa: BLE001
            log.debug("vision event not sent", exc_info=True)


def _set(**kw) -> None:
    with _lock:
        _S.update(kw)


def _fail(code: str, message: str, state: str = "error") -> None:
    _set(state=state, error={"code": code, "message": message})
    _notify()


# ---------- public API ----------
def status() -> dict:
    with _lock:
        now = time.time()
        s = dict(_S)
        return {
            "state": s["state"], "running": s["state"] in ("running", "starting"), "paused": s["state"] == "paused",
            "error": s["error"], "summary": s["summary"], "age_s": round(now - s["seen_ts"], 1) if s["seen_ts"] else None,
            "changed_s": round(now - s["summary_ts"], 1) if s["summary_ts"] else None, "frames": s["frames"], "analysed": s["analysed"],
            "skipped_busy": s["skipped_busy"], "last_analysis_ms": s["last_ms"], "capture_fps": s["fps"], "screen": s["screen"],
            "model": VISION_MODEL or ai.model(), "auto": _auto, "capture": _capture_name, "stale": s["stale"],
        }


def start(auto: bool = False) -> dict:
    global _thread, _manual_off, _auto, _touch
    if not auto:
        _manual_off = False
    _auto, _touch = bool(auto), time.time()
    if sys.platform != "win32":
        raise RequestError(VISION_UNAVAILABLE, "Live Vision needs Windows (DXcam captures the Windows desktop).")
    try:
        from PIL import ImageGrab  # noqa: F401, PLC0415
    except ImportError:
        try:
            import dxcam  # noqa: F401, PLC0415
        except ImportError:
            raise RequestError(VISION_UNAVAILABLE, f"No screen capture library for {sys.executable}. Run:  \"{sys.executable}\" -m pip install pillow numpy dxcam opencv-python-headless") from None
    with _lock:
        if _thread is not None and _thread.is_alive() and not _stop.is_set():
            if _S["state"] == "paused":
                return resume()
            return status()
        if _thread is not None and _thread.is_alive():  # a previous stop is still finishing
            _thread.join(timeout=3)
        _reset()
        _S.update(state="starting", started=time.time())
        _stop.clear()
        _running.set()
        _thread = threading.Thread(target=_loop, name="fidex-vision", daemon=True)
        _thread.start()
    _notify()
    return status()


def pause() -> dict:
    with _lock:
        if _S["state"] in ("running", "starting"):
            _running.clear()
            _S["state"] = "paused"
    yield_to_brain()
    _notify()
    return status()


def resume() -> dict:
    with _lock:
        if _S["state"] != "paused":
            return status()
        _S["state"] = "running"
        _S["error"] = None
        _running.set()
    _notify()
    return status()


def stop(manual: bool = True) -> dict:
    global _thread, _manual_off, _auto
    if manual:
        _manual_off = True
    _auto = False
    _stop.set()
    _running.set()  # wake a paused loop so it can exit
    yield_to_brain()
    t = _thread
    if t is not None and t is not threading.current_thread():
        t.join(timeout=3)
    _thread = None
    with _lock:
        _S.update(state="stopped", error=None, summary="", summary_ts=0.0, seen_ts=0.0)
    _notify()
    return status()


def auto_start() -> bool:
    """Called when a task starts: vision switches itself on (the user does not have to). Never raises, never blocks the task.
    Respects a manual Stop. Returns True when vision is (now) running."""
    global _touch
    _touch = time.time()
    if _manual_off:
        return False
    with _lock:
        if _S["state"] in ("running", "starting"):
            return True
        if _S["state"] == "paused":
            return False  # the user paused it on purpose
    try:
        start(auto=True)
        return True
    except RequestError as err:
        _set(state="stopped", error={"code": err.code, "message": err.message})
        log.info("vision not started automatically: %s", err.message)
        return False
    except Exception:  # noqa: BLE001
        log.exception("automatic vision start failed")
        return False


def _grab_once():
    """One direct Pillow screenshot (numpy array) that needs no running session, no DXcam and no change on screen. None if impossible."""
    try:
        import numpy as np  # noqa: PLC0415
        from PIL import ImageGrab  # noqa: PLC0415

        return np.asarray(ImageGrab.grab().convert("RGB"))
    except Exception:  # noqa: BLE001
        log.warning("one-shot screen grab failed", exc_info=True)
        return None


def fresh_jpeg(timeout: float = 4.0, width: int | None = None) -> tuple[str, tuple[int, int]] | None:
    """A JPEG (base64) of the screen as it is NOW, for the see-and-correct check. Starts vision if needed; None when impossible."""
    global _touch, _last_frame
    _touch = t_req = time.time()
    if _S["state"] not in ("running", "starting"):
        auto_start()  # may refuse (user pressed Stop / paused): the one-shot grab below still lets the eye see for this task
    end = time.time() + (0 if _auto else min(timeout, 1.5))  # task mode runs no capture loop: take the one picture directly
    while time.time() < end:  # the capture loop confirms the screen every ~0.15 s
        frame = _last_frame
        if frame is not None and _S["seen_ts"] >= t_req:
            return _jpeg_b64(frame, width), (int(frame.shape[1]), int(frame.shape[0]))
        time.sleep(0.05)
    # DXcam returns nothing while the screen is unchanged, and vision may be stopped/paused: take the picture directly.
    frame = _grab_once()
    if frame is None:
        frame = _last_frame
    if frame is None:
        return None
    _last_frame = frame
    return _jpeg_b64(frame, width), (int(frame.shape[1]), int(frame.shape[0]))


def active_window(hwnd=None) -> dict | None:
    """The window in front RIGHT NOW, straight from Windows (instant, exact, no model): {title, exe, rect:(l,t,r,b) visible frame, dpi}."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        u, k = ctypes.windll.user32, ctypes.windll.kernel32
        hwnd = hwnd or u.GetForegroundWindow()
        if not hwnd:
            return None
        n = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        pid = wintypes.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        exe = ""
        h = k.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if h:
            sz = wintypes.DWORD(520)
            pb = ctypes.create_unicode_buffer(520)
            if k.QueryFullProcessImageNameW(h, 0, pb, ctypes.byref(sz)):
                exe = os.path.basename(pb.value)
            k.CloseHandle(h)
        r = wintypes.RECT()
        if ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r)) != 0:  # visible frame without the shadow
            u.GetWindowRect(hwnd, ctypes.byref(r))
        try:
            dpi = u.GetDpiForWindow(hwnd) or 96
        except Exception:  # noqa: BLE001
            dpi = 96
        return {"title": buf.value, "exe": exe, "rect": (r.left, r.top, r.right, r.bottom), "dpi": dpi}
    except Exception:  # noqa: BLE001
        log.debug("active window lookup failed", exc_info=True)
        return None


def _is_fidex(w: dict | None) -> bool:
    return bool(w) and ("fidex" in (w["title"] + w["exe"]).lower() or w["exe"].lower() == "electron.exe")


def real_active_window() -> dict | None:
    """The app the user means. When FIDEX AI itself is in front (they are typing in it) this is the first real app BEHIND it
    (marked 'behind': True), found by walking the window order on Windows. No model."""
    w = active_window()
    if not _is_fidex(w) or sys.platform != "win32":
        return w
    try:
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        u = ctypes.windll.user32
        hwnd = u.GetForegroundWindow()
        for _ in range(80):
            hwnd = u.GetWindow(hwnd, 2)  # GW_HWNDNEXT: the next window down in the stacking order
            if not hwnd:
                break
            if not u.IsWindowVisible(hwnd) or u.IsIconic(hwnd):
                continue
            cloaked = wintypes.DWORD()
            ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))  # DWMWA_CLOAKED
            if cloaked.value:
                continue
            info = active_window(hwnd)
            if info and info["title"].strip() and info["title"] not in ("Program Manager", "Windows Input Experience") and not _is_fidex(info):
                info["behind"] = True
                return info
    except Exception:  # noqa: BLE001
        log.debug("window walk failed", exc_info=True)
    return w


def window_sentence(w: dict | None) -> str:
    if not w:
        return ""
    name = f"{w['title'] or '(no title)'} [{w['exe'] or 'unknown app'}]"
    if w.get("behind"):
        return f"FIDEX AI is in front because the user is typing in it. The app behind it is {name}."
    return f"The active app is {name}."


def active_window_text() -> str:
    return window_sentence(real_active_window())


ASK_PROMPT = (
    "Look at the screenshot and answer ONLY this question, in the fewest words possible. "
    "If it asks for names, reply with just the names separated by commas. No description, no extra words, no window names. Question: "
)
ASK_WIDTH = int(os.environ.get("FIDEX_VISION_ASK_WIDTH", "1024"))  # wide enough to READ icon names
ASK_TOKENS = 50


def ask_screen(question: str) -> str:
    """The eye answers ONE question about the screen right now, as shortly as possible. '' when impossible."""
    yield_to_brain()  # the background description must not compete with this answer
    shot = fresh_jpeg(timeout=1.0, width=ASK_WIDTH)
    if shot is None:
        return ""
    got = ai._gen_lock.acquire(blocking=False)
    try:
        text, _ = ai._stream_ask([{"role": "user", "content": ASK_PROMPT + question.strip()[:300], "images": [shot[0]]}], lambda t: None, think=False, num_predict=ASK_TOKENS, model_name=VISION_MODEL)
    finally:
        if got:
            ai._gen_lock.release()
    return (text or "").strip()


def look_now() -> str:
    """ONE on-demand description of the screen right now (no waiting for the background loop). '' when impossible."""
    shot = fresh_jpeg(timeout=2.0)
    if shot is None:
        return ""
    got = ai._gen_lock.acquire(blocking=False)  # chat may already hold it (non-streaming path): then just go, Ollama queues by itself
    try:
        text, _ = ai._stream_ask([{"role": "user", "content": PROMPT, "images": [shot[0]]}], lambda t: None, think=False, num_predict=VISION_TOKENS, model_name=VISION_MODEL)
    finally:
        if got:
            ai._gen_lock.release()
    text = (text or "").strip()
    if text:
        with _lock:
            _S["summary"], _S["summary_ts"], _S["stale"] = text, time.time(), False
    return text


# ---------- the always-on eye: windows, cursor, instant verification (no model, ~0 cost) ----------
_eye: dict = {"titles": [], "active": "", "cursor": (0, 0), "ts": 0.0}
_STOP = {"create", "folder", "folders", "files", "named", "called", "desktop", "containing", "inside", "which", "there", "their", "then", "open", "with", "from", "that",
         "this", "make", "write", "print", "python", "please", "fidex", "using", "click", "right", "mouse", "keyboard", "screen", "window", "again", "after", "before"}
_ALIASES = (("vs code", "visual studio code"), ("vscode", "visual studio code"), ("visual studio code", "visual studio code"), ("file explorer", "file explorer"),
            ("chrome", "chrome"), ("notepad", "notepad"), ("edge", "edge"), ("calculator", "calculator"), ("paint", "paint"))


def _enum_titles() -> list[str]:
    import ctypes  # noqa: PLC0415
    from ctypes import wintypes  # noqa: PLC0415

    u, dwm = ctypes.windll.user32, ctypes.windll.dwmapi
    out: list[str] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lp):
        if not u.IsWindowVisible(hwnd):
            return True
        n = u.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        cloaked = wintypes.DWORD()
        dwm.DwmGetWindowAttribute(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        if cloaked.value:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(hwnd, buf, n + 1)
        if buf.value not in ("Program Manager", "Windows Input Experience"):
            out.append(buf.value)
        return True

    u.EnumWindows(cb, 0)
    return out


def _tick_eye(force: bool = False) -> None:
    """The eye's constant watching: which windows are open, which is in front, where the mouse is. Runs ~2x a second inside the capture loop."""
    if sys.platform != "win32" or (not force and time.time() - _eye["ts"] < 0.5):
        return
    try:
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        pt = wintypes.POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        w = active_window()
        with _lock:
            _eye.update(titles=_enum_titles(), active=(w or {}).get("title", ""), cursor=(pt.x, pt.y), ts=time.time())
    except Exception:  # noqa: BLE001
        log.debug("eye tick failed", exc_info=True)


def eye_state() -> dict:
    _tick_eye(force=time.time() - _eye["ts"] > 2.0)
    with _lock:
        return dict(_eye)


def goal_visible(goal: str) -> str | None:
    """INSTANT check (no model): is something the goal talks about open on screen right now? Returns that window's title, or None."""
    st = eye_state()
    titles = [t for t in st["titles"] if "fidex" not in t.lower()]
    low = (goal or "").lower()
    wants = [b for a, b in _ALIASES if a in low]
    wants += [w for w in re.findall(r"[a-z0-9_.]{5,}", low) if w not in _STOP]
    for w in wants:
        for t in titles:
            if w in t.lower():
                return t
    return None


def yield_to_brain() -> None:
    """Cancels a vision analysis in flight (planning/chat has priority). Safe to call at any time."""
    sid = _inflight
    if sid:
        try:
            ai.cancel(sid)
        except Exception:  # noqa: BLE001
            pass


def context() -> str:
    """What is on screen right now, for the planner prompts. "" unless vision is running with a fresh look."""
    with _lock:
        if _S["state"] != "running" or not _S["summary"] or time.time() - _S["seen_ts"] > FRESH_FOR or _S["stale"]:
            return ""  # stale = the screen changed after this description was written: it would describe the PREVIOUS screen
        age = round(time.time() - _S["summary_ts"])
        screen = _S["screen"]
        text = _S["summary"]
    size = f" (screen {screen[0]}x{screen[1]})" if screen else ""
    return f"Live screen{size}, seen {age}s ago: {text}"


# ---------- capture + analysis loop ----------
def _thumb(frame):
    import numpy as np  # noqa: PLC0415

    h, w = frame.shape[:2]
    sub = frame[:: max(1, h // 36), :: max(1, w // 64)]
    return (sub[..., 0].astype("float32") * 0.3 + sub[..., 1].astype("float32") * 0.59 + sub[..., 2].astype("float32") * 0.11), np


def _jpeg_b64(frame, width: int | None = None) -> str:
    from PIL import Image  # noqa: PLC0415

    img = Image.fromarray(frame)
    width = width or MAX_WIDTH
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode("ascii")


class _PilCamera:
    """Fallback capture (Pillow ImageGrab, already installed with PyAutoGUI) used when DXcam cannot be imported by THIS Python
    or cannot open the screen. Same grab() contract as DXcam: a frame, ~4 per second at most."""

    def __init__(self) -> None:
        self._t = 0.0

    def grab(self):
        import numpy as np  # noqa: PLC0415
        from PIL import ImageGrab  # noqa: PLC0415

        wait = 0.25 - (time.monotonic() - self._t)
        if wait > 0:
            time.sleep(wait)
        self._t = time.monotonic()
        return np.asarray(ImageGrab.grab().convert("RGB"))

    def release(self) -> None:
        pass


def _new_camera():
    global _capture_name
    try:
        if _force_pil:
            raise RuntimeError("DXcam disabled after capture errors")
        import dxcam  # noqa: PLC0415

        cam = dxcam.create(output_color="RGB")
        if cam is not None:
            _capture_name = "dxcam"
            return cam
        log.warning("DXcam could not open the screen; using Pillow capture")
    except ImportError:
        log.warning("DXcam is not installed for %s; using Pillow capture", sys.executable)
    except Exception as err:  # noqa: BLE001
        log.warning("DXcam failed (%s); using Pillow capture", err)
    _capture_name = "pillow"
    return _PilCamera()


def _release(cam) -> None:
    try:
        if cam is not None:
            cam.release()
    except Exception:  # noqa: BLE001
        pass


def _describe(frame) -> str:
    """One Ollama call. Takes the generation lock WITHOUT waiting: when the brain is busy the frame is skipped."""
    global _inflight
    if not ai._gen_lock.acquire(blocking=False):
        _set(skipped_busy=_S["skipped_busy"] + 1)
        return ""
    sid = "vision-" + uuid.uuid4().hex[:10]
    stream = ai._register(sid)
    _inflight = sid
    try:
        if _stop.is_set() or not _running.is_set():
            return ""
        t0 = time.monotonic()
        msgs = [{"role": "user", "content": PROMPT, "images": [_jpeg_b64(frame)]}]
        text, timings = ai._stream_ask(msgs, lambda t: None, think=False, stream=stream, num_predict=VISION_TOKENS, model_name=VISION_MODEL)
        if timings.get("cancelled"):
            return ""
        _set(last_ms=round((time.monotonic() - t0) * 1000))
        return (text or "").strip()
    finally:
        _inflight = ""
        ai._unregister(sid)
        ai._gen_lock.release()


def _loop() -> None:
    cam = None
    prev = None  # grey thumbnail of the last ANALYSED frame
    last_analysis = 0.0
    capture_fails = 0
    ai_backoff = 0.0
    fps_t, fps_n = time.monotonic(), 0
    try:
        while not _stop.is_set():
            if _auto and AUTO_IDLE and time.time() - _touch > AUTO_IDLE:  # a task switched vision on and none has used it for a while: switch off
                log.info("vision switched itself off (idle)")
                break
            if not _running.is_set():  # paused: release nothing, do nothing
                _running.wait(0.2)
                continue
            _tick_eye()
            if _auto:  # started by a task: NO capture loop, NO screenshots. The eye reads Windows (UI Automation / window list) and takes one picture only when asked (fresh_jpeg)
                time.sleep(0.4)
                continue
            if ai_backoff:
                waited = 0.0
                while waited < ai_backoff and not _stop.is_set() and _running.is_set():
                    time.sleep(0.2)
                    waited += 0.2
                ai_backoff = 0.0
            # ---- capture ----
            try:
                if cam is None:
                    cam = _new_camera()
                frame = cam.grab()
                capture_fails = 0
                if _S["state"] == "starting" or (_S["error"] and _S["error"]["code"].startswith("CAPTURE")):
                    _set(state="running", error=None)
                    _notify()
            except Exception as err:  # noqa: BLE001
                capture_fails += 1
                _set(capture_errors=_S["capture_errors"] + 1)
                _release(cam)
                cam = None  # re-created on the next round (handles lock screen, resolution change, display sleep)
                log.warning("capture failed (%d): %s", capture_fails, err)
                if _capture_name == "dxcam" and not _force_pil:
                    globals()["_force_pil"] = True  # next round uses Pillow ImageGrab (needs only pillow + numpy)
                    log.warning("switching from DXcam to Pillow capture")
                    continue
                if capture_fails >= 3:
                    _fail("CAPTURE_FAILED", f"Cannot capture the screen: {err}. Retrying. (Lock screen, secure desktop or a display change can cause this.)")
                time.sleep(min(5.0, 0.5 * capture_fails))
                continue
            now = time.time()
            if frame is None and _last_frame is None:  # nothing seen yet and DXcam has no "change": take the first picture directly
                frame = _grab_once()
            if frame is None:  # DXcam: the screen did not change since the last grab, so the last description is still true
                _set(seen_ts=now)
                if _S["state"] == "starting":
                    _set(state="running")
                time.sleep(0.15)
                continue
            else:
                fps_n += 1
                globals()["_last_frame"] = frame
                _set(frames=_S["frames"] + 1, screen=(int(frame.shape[1]), int(frame.shape[0])), seen_ts=now)
                if time.monotonic() - fps_t >= 2:
                    _set(fps=round(fps_n / (time.monotonic() - fps_t), 1))
                    fps_t, fps_n = time.monotonic(), 0
            if _auto:  # started by a task: capture only. The model looks on demand (see_check / click_on / look_now), so it never competes with the brain
                time.sleep(0.15)
                continue
            # ---- decide whether this frame deserves an AI look ----
            gray, np = _thumb(frame)
            changed = prev is None or float(np.abs(gray - prev).mean()) >= CHANGE_THRESHOLD
            due = time.time() - last_analysis >= MIN_GAP
            if changed:
                _set(stale=True)
            if not (changed and due) and time.time() - last_analysis < HEARTBEAT:
                time.sleep(0.1)
                continue
            # ---- understand it (local Ollama) ----
            try:
                text = _describe(frame)
                if text:
                    with _lock:
                        _S["summary"], _S["summary_ts"], _S["analysed"] = text, time.time(), _S["analysed"] + 1
                        _S["stale"] = False
                        _S["history"] = (_S["history"] + [text])[-3:]
                        _S["ai_errors"] = 0
                        if _S["error"] and _S["error"]["code"].startswith("AI_"):
                            _S["error"] = None
                    prev = gray
                    _notify()
                last_analysis = time.time()
            except RequestError as err:
                with _lock:
                    _S["ai_errors"] += 1
                code = err.code if str(err.code).startswith("AI_") else "AI_ERROR"
                msg = err.message
                if "image" in msg.lower() or "vision" in msg.lower() or "multimodal" in msg.lower():
                    msg += "  (The selected model must support images; FIDEX uses qwen3.5:4b unless FIDEX_VISION_MODEL is set.)"
                log.warning("vision analysis failed: %s", msg)
                _fail(code, msg, state="running")  # keeps running: controls still work, retries with back-off
                ai_backoff = min(15.0, 2.0 * _S["ai_errors"])
                last_analysis = time.time()
            except Exception as err:  # noqa: BLE001
                log.exception("vision analysis crashed")
                _fail("VISION_ERROR", f"{type(err).__name__}: {err}", state="running")
                ai_backoff = 5.0
                last_analysis = time.time()
    finally:
        _release(cam)
        if not _stop.is_set():  # ended by itself (idle): report it
            _set(state="stopped", summary="", summary_ts=0.0, seen_ts=0.0)
            _notify()
        log.info("vision loop ended")
