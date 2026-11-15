"""Offline text-to-speech via Piper. Request: synthesize_speech {text} -> {audio_base64 (wav), sample_rate}.
Model: assets/tts/en_US-lessac-medium.onnx (+ .onnx.json). Uses the piper Python package, else a piper executable."""
from __future__ import annotations

import base64
import io
import json
import queue
import threading
import os
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError

_ROOT = Path(__file__).resolve().parents[2]
_MODEL = "en_US-lessac-medium.onnx"
_voice = None


def _dirs() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("FIDEX_TTS_DIR")
    if env:
        out.append(Path(env))
    data = os.environ.get("FIDEX_DATA_DIR")
    if data:
        out += [Path(data) / "tts", Path(data) / "assets" / "tts"]
    for b in (_ROOT, _ROOT.parent, _ROOT / "backend", Path.cwd(), Path.cwd().parent):
        out += [b / "assets" / "tts", b / "resources" / "tts", b / "app.asar.unpacked" / "assets" / "tts", b / "src" / "renderer" / "assets" / "tts"]
    return out


def _model() -> Path:
    for d in _dirs():
        if (d / _MODEL).is_file():
            return d / _MODEL
    raise RequestError("TTS_UNAVAILABLE", f"Piper voice {_MODEL} not found in assets/tts")


def _exe() -> str | None:
    for d in _dirs() + [d.parent / "piper" for d in _dirs()]:
        for n in ("piper.exe", "piper"):
            if (d / n).is_file():
                return str(d / n)
            if (d / "piper" / n).is_file():
                return str(d / "piper" / n)
    return shutil.which("piper")


def _wav_lib(text: str, model: Path) -> bytes | None:
    global _voice
    try:
        from piper import PiperVoice  # type: ignore
    except Exception:
        return None
    if _voice is None:
        cfg = Path(str(model) + ".json")
        _voice = PiperVoice.load(str(model), config_path=str(cfg) if cfg.is_file() else None)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        if hasattr(_voice, "synthesize_wav"):
            _voice.synthesize_wav(text, w)
        else:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(_voice.config.sample_rate)
            _voice.synthesize(text, w)
    return buf.getvalue()


def _wav_exe(text: str, model: Path) -> bytes:
    exe = _exe()
    if not exe:
        raise RequestError("TTS_UNAVAILABLE", "Piper is not installed (no piper package or executable found)")
    fd, out = tempfile.mkstemp(suffix=".wav"); os.close(fd)
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        r = subprocess.run([exe, "--model", str(model), "--output_file", out], input=text.encode("utf-8"), capture_output=True, timeout=60, creationflags=flags)
        if r.returncode != 0:
            raise RequestError("TTS_UNAVAILABLE", r.stderr.decode("utf-8", "ignore")[-300:] or "piper failed")
        return Path(out).read_bytes()
    finally:
        try: os.remove(out)
        except OSError: pass


# --- Persistent Piper process: the voice model is loaded once, so every sentence is spoken in a fraction of a second ---
_proc = None
_q: "queue.Queue[str]" = queue.Queue()
_plock = threading.Lock()


def _reader(p) -> None:
    for raw in iter(p.stdout.readline, b""):
        _q.put(raw.decode("utf-8", "ignore").strip())


def _proc_start(exe: str, model: Path) -> None:
    global _proc, _q
    out_dir = tempfile.mkdtemp(prefix="fidex_tts_")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    _q = queue.Queue()
    _proc = subprocess.Popen([exe, "--model", str(model), "--json-input", "--output_dir", out_dir], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)
    threading.Thread(target=_reader, args=(_proc,), daemon=True).start()


def _wav_exe_fast(text: str, model: Path) -> bytes:
    global _proc
    exe = _exe()
    if not exe:
        raise RequestError("TTS_UNAVAILABLE", "Piper is not installed")
    with _plock:
        if _proc is None or _proc.poll() is not None:
            _proc_start(exe, model)
        try:
            _proc.stdin.write((json.dumps({"text": text}) + "\n").encode("utf-8")); _proc.stdin.flush()
            path = _q.get(timeout=25)
        except Exception:
            try: _proc.kill()
            except Exception: pass
            _proc = None
            raise
    data = Path(path).read_bytes()
    try: os.remove(path)
    except OSError: pass
    return data


def _preload() -> None:
    try:
        model = _model()
        if _wav_lib("Ready.", model) is None:
            _wav_exe_fast("Ready.", model)
    except Exception:
        pass


threading.Thread(target=_preload, daemon=True).start()


@handler("synthesize_speech")
def synthesize_speech(payload: dict) -> dict:
    text = str((payload or {}).get("text") or "").strip()
    if not text:
        raise RequestError(INVALID_PAYLOAD, "text is required")
    text = text[:1500]
    model = _model()
    try:
        wav = _wav_lib(text, model)
    except RequestError:
        raise
    except Exception:
        wav = None
    if not wav:
        try:
            wav = _wav_exe_fast(text, model)
        except Exception:
            wav = _wav_exe(text, model)
    with wave.open(io.BytesIO(wav)) as w:
        rate = w.getframerate()
    return {"audio_base64": base64.b64encode(wav).decode("ascii"), "sample_rate": rate}
