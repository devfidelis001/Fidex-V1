"""Offline speech-to-text via whisper.cpp (whisper-cli). Request: transcribe_audio.

    transcribe_audio {audio_base64, format?, sample_rate?, language?} -> {text, language}

Binary/model lookup: FIDEX_WHISPER_BIN / FIDEX_WHISPER_MODEL, else assets/whisper/ (project root,
resources dir, or backend/assets/whisper). Any whisper-cli(.exe)/main(.exe) and any ggml-*.bin/model.bin works.
"""
from __future__ import annotations

import base64
import binascii
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError

HANDLER_FAILED = "STT_UNAVAILABLE"
_ROOT = Path(__file__).resolve().parents[2]
_BINS = ("whisper-cli.exe", "whisper-cli", "whisper-cpp.exe", "whisper-cpp", "whisper.exe", "main.exe")


def _dirs() -> list[Path]:
    """Every place a bundled whisper folder can live: dev tree, packaged resources, asar.unpacked, userData, cwd."""
    out: list[Path] = []
    env_dir = os.environ.get("FIDEX_WHISPER_DIR")
    if env_dir:
        out.append(Path(env_dir))
    data = os.environ.get("FIDEX_DATA_DIR")
    if data:
        out += [Path(data) / "whisper", Path(data) / "assets" / "whisper"]
    for base in (_ROOT, _ROOT.parent, _ROOT / "backend", Path.cwd(), Path.cwd().parent):
        out += [base / "assets" / "whisper", base / "resources" / "whisper", base / "whisper",
                base / "app.asar.unpacked" / "assets" / "whisper"]
    seen, res = set(), []
    for d in out:
        k = str(d).lower()
        if k not in seen:
            seen.add(k)
            res.append(d)
    return res


def _find_bin() -> str | None:
    env = os.environ.get("FIDEX_WHISPER_BIN")
    if env:
        if Path(env).is_file():
            return env
        found = shutil.which(env)
        if found:
            return found
    for d in _dirs():
        for n in _BINS:
            if (d / n).is_file():
                return str(d / n)
    # fallback: any .exe in the folder (e.g. 'whisper-cli.exe.exe' from hidden Windows extensions, or renamed builds)
    for d in _dirs():
        if d.is_dir():
            exes = sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() == ".exe")
            exes.sort(key=lambda p: ("main" in p.name.lower(), p.name))
            if exes:
                return str(exes[0])
    # last resort: bounded search of the project folder and its parent for the files wherever they were put
    for root in (_ROOT, _ROOT.parent):
        found = _scan(root)
        if found:
            return found
    return shutil.which("whisper-cli")


def _scan(root: Path, kind: str = "exe") -> str | None:
    skip = {"node_modules", ".git", ".venv", "venv", "__pycache__", "data"}
    base = len(root.parts)
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in skip]
        if len(Path(dp).parts) - base >= 5:
            dn[:] = []
        for f in fn:
            low = f.lower()
            if kind == "exe" and low in ("whisper-cli.exe", "whisper-cli"):
                return str(Path(dp) / f)
            if kind == "bin" and low.startswith("ggml-") and low.endswith(".bin"):
                return str(Path(dp) / f)
    return None


def _listing() -> str:
    for d in _dirs():
        if d.is_dir():
            try:
                return f"{d} contains: {', '.join(sorted(x.name for x in d.iterdir())) or '(empty)'}"
            except OSError:
                pass
    return "no assets/whisper folder found"


def _find_model() -> str | None:
    env = os.environ.get("FIDEX_WHISPER_MODEL")
    if env and Path(env).is_file():
        return env
    for d in _dirs():
        if not d.is_dir():
            continue
        if (d / "model.bin").is_file():
            return str(d / "model.bin")
        models = sorted(list(d.glob("ggml-*.bin")) + list(d.glob("*.bin")), key=lambda m: (".en" in m.name, m.name))
        if models:
            return str(models[0])
    for root in (_ROOT, _ROOT.parent):
        found = _scan(root, "bin")
        if found:
            return found
    return None


_HALLU = re.compile(r"^(thanks? you( for watching)?\.?|you\.?|bye\.?|\.+)$", re.I)


def clean_output(stdout: str) -> str:
    text = " ".join(l.strip() for l in stdout.splitlines() if l.strip())
    text = re.sub(r"\[[^\]]*\]|\((?:[^)]*)\)|\*[^*]*\*", " ", text)  # [BLANK_AUDIO], (music), *noise*
    text = re.sub(r"\s+", " ", text).strip()
    return "" if _HALLU.match(text) else text


@handler("transcribe_audio")
def transcribe_audio(payload: dict) -> dict:
    b64 = payload.get("audio_base64")
    if not isinstance(b64, str) or not b64:
        raise RequestError(INVALID_PAYLOAD, "'audio_base64' must be a non-empty string.")
    try:
        audio = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise RequestError(INVALID_PAYLOAD, "'audio_base64' is not valid base64.")
    if len(audio) < 1000:
        return {"text": "", "language": "auto"}
    lang = payload.get("language")
    lang = lang if isinstance(lang, str) and re.fullmatch(r"[a-z]{2,3}|auto", lang) else "en"

    binary, model = _find_bin(), _find_model()
    if not binary:
        raise RequestError(HANDLER_FAILED, "whisper.cpp not found. Searched: " + "; ".join(str(d) for d in _dirs()[:6]) + ". " + _listing() + ". Put whisper-cli.exe in assets/whisper/ or set FIDEX_WHISPER_BIN.")
    if not model:
        raise RequestError(HANDLER_FAILED, "Whisper model not found. Put model.bin (or ggml-*.bin) in assets/whisper/ or set FIDEX_WHISPER_MODEL.")

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "in.wav")
        with open(wav, "wb") as f:
            f.write(audio)
        final = bool(payload.get("final"))
        cmd = [binary, "-m", model, "-f", wav, "-l", lang, "-nt", "-np", "-nf", "-bs", "5" if final else "1", "-bo", "5" if final else "1", "-t", str(max(2, min(8, (os.cpu_count() or 4) - 1)))]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), cwd=os.path.dirname(os.path.abspath(binary)) if os.path.isfile(binary) else None)
        except subprocess.TimeoutExpired:
            raise RequestError(HANDLER_FAILED, "Transcription took too long.")
        except OSError as e:
            raise RequestError(HANDLER_FAILED, f"Could not start whisper.cpp: {e}")
        if proc.returncode != 0:
            raise RequestError(HANDLER_FAILED, (proc.stderr or "whisper failed").strip()[-300:])
        if "deprecated" in (proc.stderr or "").lower() and not proc.stdout.strip():
            raise RequestError(HANDLER_FAILED, "This whisper executable is the deprecated 'main' stub. Build/copy the real whisper-cli.exe (target whisper-cli) into assets/whisper/.")
        m = re.search(r"auto-detected language: (\w+)", proc.stderr or "")
        return {"text": clean_output(proc.stdout), "language": m.group(1) if m else lang}
