"""Request handlers. To add a feature in a later step, register a new handler here.

A handler receives the request payload (a dict) and returns JSON-serialisable data.
It signals an expected problem by raising RequestError(code, message).

Step 4 handlers (ping, hello, backend.info) are communication tests only. None of them is AI.
Step 5 adds local storage; those handlers live in storage_handlers.py and are registered at the
bottom of this file.
"""
from __future__ import annotations

import os
import platform
import sys
import time
from datetime import datetime, timezone
from typing import Callable

from . import PROTOCOL_VERSION, __version__
from .protocol import INVALID_PAYLOAD, RequestError

HANDLERS: dict[str, Callable[[dict], object]] = {}
_STARTED = time.monotonic()
MAX_MESSAGE_CHARS = 2000


def handler(name: str):
    def register(func):
        HANDLERS[name] = func
        return func

    return register


def debug_enabled() -> bool:
    """Crash/sleep helpers used by the automated tests. Never enabled in normal use."""
    return os.environ.get("FIDEX_BACKEND_TEST") == "1"


@handler("ping")
def ping(payload: dict) -> dict:
    return {"pong": True, "time": datetime.now(timezone.utc).isoformat()}


@handler("hello")
def hello(payload: dict) -> dict:
    """Step 4 communication test: echo a message back so JavaScript can prove the round trip."""
    message = payload.get("message")
    if not isinstance(message, str) or not message.strip():
        raise RequestError(INVALID_PAYLOAD, "'message' must be a non-empty string.")
    if len(message) > MAX_MESSAGE_CHARS:
        raise RequestError(INVALID_PAYLOAD, f"'message' is longer than {MAX_MESSAGE_CHARS} characters.")
    return {
        "reply": f"Python backend received: {message}",
        "received": message,
        "from": "fidex-python-backend",
        "brain_connected": False,
        "note": "Communication test only. The FIDEX AI brain is not connected yet.",
    }


@handler("backend.info")
def backend_info(payload: dict) -> dict:
    return {
        "name": "FIDEX AI backend",
        "backend_version": __version__,
        "protocol": PROTOCOL_VERSION,
        "python": platform.python_version(),
        "pid": os.getpid(),
        "uptime_s": round(time.monotonic() - _STARTED, 3),
        "handlers": sorted(n for n in HANDLERS if not n.startswith("debug.")) + ["shutdown"],
    }


# ---------- Test-only helpers (registered only when FIDEX_BACKEND_TEST=1) ----------
if debug_enabled():

    @handler("debug.sleep")
    def debug_sleep(payload: dict) -> dict:
        seconds = payload.get("seconds", 1)
        if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not 0 <= seconds <= 60:
            raise RequestError(INVALID_PAYLOAD, "'seconds' must be a number from 0 to 60.")
        time.sleep(seconds)
        return {"slept": seconds}

    @handler("debug.crash")
    def debug_crash(payload: dict) -> dict:
        os._exit(3)  # simulates the Python process dying without any goodbye

    @handler("debug.raise")
    def debug_raise(payload: dict) -> dict:
        raise ValueError("deliberate failure for tests")

    @handler("debug.print")
    def debug_print(payload: dict) -> dict:
        print("stray text that must never reach the protocol stream")
        return {"printed": True}

    @handler("debug.big")
    def debug_big(payload: dict) -> dict:
        size = payload.get("size", 100000)
        return {"text": "x" * int(size), "unicode": "café ✓ \U0001f680"}


# ---------- Step 5: local storage handlers (registered by importing the module) ----------
# Imported last because storage_handlers uses `handler` from this module.
from . import storage_handlers  # noqa: E402,F401


# ---------- AI brain (Ollama + qwen3:4b) ----------
from . import ai_handlers  # noqa: E402,F401
