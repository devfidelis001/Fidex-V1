"""Offline speech-to-text handler for the "transcribe_audio" backend request.
Uses the existing whisper.cpp runtime (whisper-cli) with automatic language detection.
Set FIDEX_WHISPER_BIN and FIDEX_WHISPER_MODEL, or edit the two defaults below.
Register in your dispatcher:  "transcribe_audio": stt_whisper.handle
Returns {"text": str, "language": str}. Raises on failure (wrap into your {ok:false,error} format).
"""
import base64, os, re, subprocess, tempfile

WHISPER_BIN = os.environ.get("FIDEX_WHISPER_BIN", "assets/whisper/whisper-cli.exe")
WHISPER_MODEL = os.environ.get("FIDEX_WHISPER_MODEL", "assets/whisper/model.bin")


def handle(payload):
    audio = base64.b64decode(payload["audio_base64"])
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "in.wav")
        with open(wav, "wb") as f:
            f.write(audio)
        proc = subprocess.run(
            [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", wav, "-l", "auto", "-nt", "-np"],
            capture_output=True, text=True, timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or "whisper failed").strip()[-300:])
        text = " ".join(l.strip() for l in proc.stdout.splitlines() if l.strip())
        text = re.sub(r"\[[A-Z_ ]+\]|\(.*?\)", "", text).strip()
        m = re.search(r"auto-detected language: (\w+)", proc.stderr or "")
        return {"text": text, "language": m.group(1) if m else "auto"}
