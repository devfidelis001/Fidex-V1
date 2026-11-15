"""Local AI brain: talks to Ollama (http://127.0.0.1:11434) using the qwen3:4b model.

Uses only the Python standard library, so no new packages are needed. Settings can be changed
with environment variables:

    FIDEX_OLLAMA_HOST    default http://127.0.0.1:11434
    FIDEX_OLLAMA_MODEL   default qwen3:4b
    FIDEX_OLLAMA_TIMEOUT default 170 (seconds to wait for one answer)
"""
from __future__ import annotations

import json
import logging
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request

from . import memory
from .protocol import INVALID_PAYLOAD, RequestError

log = logging.getLogger("fidex.ai")

AI_UNAVAILABLE = "AI_UNAVAILABLE"  # Ollama is not running / not reachable
AI_MODEL_MISSING = "AI_MODEL_MISSING"  # Ollama runs but the model is not installed
AI_TIMEOUT = "AI_TIMEOUT"  # the model took too long
AI_ERROR = "AI_ERROR"  # Ollama answered with something unusable

DEFAULT_HOST = "http://127.0.0.1:11434"
DEFAULT_MODEL = "qwen3:4b"
DEFAULT_TIMEOUT = 170.0

MAX_HISTORY_MESSAGES = 24  # most recent messages considered as conversation memory
MAX_HISTORY_CHARS = 5000  # budget for recent messages kept in full (newest first)
OLD_SNIPPET_CHARS = 160  # older messages are shortened to this many chars instead of being forgotten
MAX_OLD_CHARS = 1600  # total budget for those shortened older messages
MAX_MESSAGE_CHARS = 6000
FULL_PROFILE_CHARS = 1600  # Take Over / Guide Me
MAX_PROFILE_CHARS = 900  # retrieved memories only, never the whole profile
NUM_CTX = 4096  # smaller context = faster prompt processing and less memory
NUM_PREDICT = 350  # hard cap on reply length keeps answers short and fast
KEEP_ALIVE = "60m"  # keep the model loaded so there is no reload delay

SYSTEM_PROMPT = (
    "You are FIDEX AI, a personal AI agent on the user's Windows computer. "
    "Reply in the user's language. Be brief and direct: answer first, 1-4 short sentences unless more is asked. "
    "Plain text only, no markdown. If unsure, say so. Use earlier conversation and what is known about the user. Do not show your reasoning."
)

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def host() -> str:
    return os.environ.get("FIDEX_OLLAMA_HOST", DEFAULT_HOST).rstrip("/")


def model() -> str:
    return os.environ.get("FIDEX_OLLAMA_MODEL", DEFAULT_MODEL)


def _timeout() -> float:
    try:
        return float(os.environ.get("FIDEX_OLLAMA_TIMEOUT", DEFAULT_TIMEOUT))
    except ValueError:
        return DEFAULT_TIMEOUT


def _call(path: str, body: dict | None, timeout: float) -> dict:
    url = host() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = json.loads(err.read().decode("utf-8", "replace")).get("error", "")
        except Exception:
            pass
        if err.code == 404 or "not found" in detail.lower():
            raise RequestError(AI_MODEL_MISSING, f"The AI model '{model()}' is not installed. Run:  ollama pull {model()}") from None
        log.warning("ollama http error %s: %s", err.code, detail)
        raise RequestError(AI_ERROR, f"The AI engine returned an error ({err.code}). {detail}".strip()) from None
    except (socket.timeout, TimeoutError):
        raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.") from None
    except urllib.error.URLError as err:
        if isinstance(err.reason, (socket.timeout, TimeoutError)):
            raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.") from None
        raise RequestError(AI_UNAVAILABLE, "Cannot reach Ollama. Start Ollama (open the Ollama app or run 'ollama serve') and try again.") from None
    except (ConnectionError, OSError):
        raise RequestError(AI_UNAVAILABLE, "Cannot reach Ollama. Start Ollama (open the Ollama app or run 'ollama serve') and try again.") from None
    except ValueError:
        raise RequestError(AI_ERROR, "The AI engine sent an unreadable answer.") from None


def status() -> dict:
    """Is Ollama reachable and is the model installed?"""
    out = {"host": host(), "model": model(), "reachable": False, "model_installed": False}
    try:
        tags = _call("/api/tags", None, 3.0)
    except RequestError as err:
        out["error"] = {"code": err.code, "message": err.message}
        return out
    out["reachable"] = True
    names = [m.get("name", "") for m in tags.get("models", []) if isinstance(m, dict)]
    want = model()
    out["model_installed"] = any(n == want or n == want + ":latest" or (":" not in want and n.startswith(want + ":")) for n in names)
    return out


def _shorten(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= OLD_SNIPPET_CHARS else text[:OLD_SNIPPET_CHARS].rstrip() + "..."


def build_messages(history: list[dict], profile: str = "", profile_limit: int = MAX_PROFILE_CHARS, system: str | None = None) -> list[dict]:
    """System prompt (+ saved user details) followed by the conversation: recent messages in full,
    older ones shortened (so facts stay remembered) within a small budget."""
    system = system or SYSTEM_PROMPT
    if profile:
        system += "\n\nUser details:\n" + profile[:profile_limit]
    recent = history[-MAX_HISTORY_MESSAGES:]
    kept: list[dict] = []
    used = old_used = 0
    for msg in reversed(recent):
        content = msg["content"]
        if not kept or used + len(content) <= MAX_HISTORY_CHARS:
            kept.append({"role": msg["role"], "content": content})
            used += len(content)
            continue
        break_at = len(kept)
        break
    else:
        break_at = None
    if break_at is not None:
        older = recent[: len(recent) - break_at]
        shortened: list[dict] = []
        for msg in reversed(older):
            short = _shorten(msg["content"])
            if old_used + len(short) > MAX_OLD_CHARS:
                break
            shortened.append({"role": msg["role"], "content": short})
            old_used += len(short)
        kept.extend(shortened)
    kept.reverse()
    while kept and kept[0]["role"] != "user":  # the model expects the memory to start with the user
        kept.pop(0)
    return [{"role": "system", "content": system}] + kept


def clean_reply(text: str) -> str:
    text = _THINK_RE.sub("", text or "")
    text = re.sub(r"^.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)  # unmatched closing tag
    return text.strip()


AGENT_PROMPTS = {
    "takeover": (
        "You are FIDEX AI in Take Over mode, working on a task the user assigned. Say briefly what you would do next, "
        "ask for any missing information, and ask for approval before anything consequential (publishing, sending, spending, deleting). "
        "You cannot execute actions yet: never claim you did something. Plain text only, short."
    ),
    "guide": (
        "You are FIDEX AI in Guide Me mode. Give short, practical, ordered guidance for the user's goal, one step at a time. "
        "Plain text only, no markdown. If unsure, say so."
    ),
}


class _ThinkFilter:
    """Removes <think>...</think> from a token stream, even when a tag is split across chunks (reasoning stays private)."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self, inside: bool = False):
        # inside=True: the model starts in its reasoning (qwen3 puts the opening <think> in the prompt, so only
        # a closing </think> appears in the output). Nothing is released until that closing tag.
        self.buf, self.inside = "", inside

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = ""
        while True:
            tag = self.CLOSE if self.inside else self.OPEN
            i = self.buf.find(tag)
            if i >= 0:
                if not self.inside:
                    out += self.buf[:i]
                self.buf, self.inside = self.buf[i + len(tag):], not self.inside
                continue
            keep = 0  # hold back a possible partial tag at the end
            for n in range(min(len(tag) - 1, len(self.buf)), 0, -1):
                if tag.startswith(self.buf[-n:]):
                    keep = n
                    break
            if not self.inside:
                out += self.buf[: len(self.buf) - keep]
            self.buf = self.buf[len(self.buf) - keep:]
            return out

    def flush(self) -> str:
        out = "" if self.inside else self.buf
        self.buf = ""
        return out


def _timings(result: dict, wall: float) -> dict:
    ms = lambda k: round((result.get(k) or 0) / 1e6)  # noqa: E731  (Ollama reports nanoseconds)
    return {
        "load_ms": ms("load_duration"),  # model loading (0 when already in memory)
        "prompt_ms": ms("prompt_eval_duration"),  # reading the prompt
        "generate_ms": ms("eval_duration"),  # writing the answer
        "ollama_total_ms": ms("total_duration"),
        "total_ms": round(wall * 1000),  # as seen by the Python backend
        "prompt_tokens": result.get("prompt_eval_count") or 0,
        "reply_tokens": result.get("eval_count") or 0,
        "thinking": False,
    }


def _ask(messages: list[dict]) -> tuple[str, dict]:
    body = {
        "model": model(),
        "messages": messages,
        "stream": False,
        "think": False,  # Qwen 3 answers straight away; extended thinking is never used
        "keep_alive": KEEP_ALIVE,
        "options": {
            "num_ctx": NUM_CTX,  # constant on purpose: a different value makes Ollama reload the model
            "num_predict": NUM_PREDICT,
            "temperature": 0.5,
            "top_k": 20,
            "top_p": 0.85,
            "repeat_penalty": 1.05,
        },
    }
    started = time.monotonic()
    result = _call("/api/chat", body, _timeout())
    message = result.get("message") if isinstance(result, dict) else None
    text = clean_reply(message.get("content", "") if isinstance(message, dict) else "")
    return text, _timings(result if isinstance(result, dict) else {}, time.monotonic() - started) | {"model": (result or {}).get("model", model())}


def _stream_ask(messages: list[dict], on_token, on_phase=lambda name: None) -> tuple[str, dict]:
    """Like _ask, but Ollama streams the answer; each visible piece goes to on_token at once.
    Only message.content is used (message.thinking and <think> blocks are dropped), so reasoning is never shown or saved."""
    body = {
        "model": model(), "messages": messages, "stream": True, "think": False, "keep_alive": KEEP_ALIVE,
        "options": {"num_ctx": NUM_CTX, "num_predict": NUM_PREDICT, "temperature": 0.5, "top_k": 20, "top_p": 0.85, "repeat_penalty": 1.05},
    }
    req = urllib.request.Request(host() + "/api/chat", data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
    started, parts, final, filt = time.monotonic(), [], {}, _ThinkFilter()
    reasoning_seen = False
    try:
        with urllib.request.urlopen(req, timeout=_timeout()) as resp:
            for raw in resp:
                raw = raw.strip()
                if not raw:
                    continue
                obj = json.loads(raw.decode("utf-8"))
                if obj.get("error"):
                    raise RequestError(AI_ERROR, f"The AI engine returned an error. {obj['error']}")
                msg = obj.get("message") or {}
                if (msg.get("thinking") or (filt.inside and msg.get("content"))) and not reasoning_seen and not parts:
                    reasoning_seen = True
                    on_phase("reasoning")  # only the fact that the model is working; its text is dropped
                piece = filt.feed(msg.get("content") or "")
                if piece:
                    if not parts:
                        piece = piece.lstrip()
                    if piece:
                        parts.append(piece)
                        on_token(piece)
                if obj.get("done"):
                    final = obj
                    break
        tail = filt.flush()
        if tail:
            parts.append(tail)
            on_token(tail)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            raise RequestError(AI_MODEL_MISSING, f"The AI model '{model()}' is not installed. Run:  ollama pull {model()}") from None
        raise RequestError(AI_ERROR, f"The AI engine returned an error ({err.code}).") from None
    except (socket.timeout, TimeoutError):
        raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.") from None
    except (urllib.error.URLError, ConnectionError, OSError):
        raise RequestError(AI_UNAVAILABLE, "Cannot reach Ollama. Start Ollama (open the Ollama app or run 'ollama serve') and try again.") from None
    except ValueError:
        raise RequestError(AI_ERROR, "The AI engine sent an unreadable answer.") from None
    text = clean_reply("".join(parts))
    return text, _timings(final, time.monotonic() - started) | {"model": final.get("model", model())}


def chat_stream(history: list[dict], profile: str = "", mode: str = "chat", on_token=lambda t: None, on_stage=lambda t: None) -> dict:
    """Streaming version of chat(): same memory rules per mode, tokens delivered through on_token.
    Every mode answers without extended thinking (think=false) and without any extra AI call, so the first
    token is the start of the real answer. on_stage is kept for compatibility but is no longer used."""
    if mode not in memory.MODES:
        raise RequestError(INVALID_PAYLOAD, f"'mode' must be one of: {', '.join(memory.MODES)}.")
    if profile:
        try:
            memory.sync_profile(profile)
        except RequestError as err:
            log.warning("profile sync failed: %s", err.message)
    question = history[-1]["content"]
    context = memory.relevant(question, mode)
    messages = build_messages(history, context, MAX_PROFILE_CHARS if mode == "chat" else FULL_PROFILE_CHARS, AGENT_PROMPTS.get(mode))
    with _gen_lock:
        text, timings = _stream_ask(messages, on_token)
    if not text:
        raise RequestError(AI_ERROR, "The AI returned an empty answer. Try asking again.")
    saved = memory.learn(question)  # only the user's own durable facts; reasoning is never stored
    log.info("chat stream timings %s", timings)
    return {"text": text, "model": timings.pop("model"), "remembered_messages": len(messages) - 1, "timings": timings, "memory_saved": len(saved), "mode": mode}


def _chat_once(history: list[dict], mode: str = "chat") -> dict:
    question = history[-1]["content"]
    messages = build_messages(history, memory.relevant(question, mode), MAX_PROFILE_CHARS if mode == "chat" else FULL_PROFILE_CHARS)
    text, timings = _ask(messages)
    if not text:
        raise RequestError(AI_ERROR, "The AI returned an empty answer. Try asking again.")
    saved = memory.learn(question)  # durable facts only; never blocks or breaks the answer
    log.info("chat timings %s", timings)
    return {"text": text, "model": timings.pop("model"), "remembered_messages": len(messages) - 1, "timings": timings, "memory_saved": len(saved)}


class _Flight:
    def __init__(self):
        self.done = threading.Event()
        self.result = None
        self.error = None


_inflight: dict = {}
_inflight_lock = threading.Lock()
_gen_lock = threading.Lock()  # one answer at a time: two at once on a small local model each run at half speed


def chat(history: list[dict], profile: str = "", mode: str = "chat") -> dict:
    if mode not in memory.MODES:
        raise RequestError(INVALID_PAYLOAD, f"'mode' must be one of: {', '.join(memory.MODES)}.")
    if profile:
        try:
            memory.sync_profile(profile)  # instant when unchanged
        except RequestError as err:
            log.warning("profile sync failed: %s", err.message)
    key = (mode, len(history), history[-1]["content"])
    with _inflight_lock:
        flight = _inflight.get(key)
        leader = flight is None
        if leader:
            flight = _inflight[key] = _Flight()
    if not leader:  # the identical question is already being answered (double send): share that answer
        flight.done.wait(_timeout() + 5)
        if flight.error:
            raise flight.error
        if flight.result is None:
            raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.")
        return flight.result
    try:
        with _gen_lock:
            flight.result = _chat_once(history, mode)
        return flight.result
    except RequestError as err:
        flight.error = err
        raise
    finally:
        flight.done.set()
        with _inflight_lock:
            _inflight.pop(key, None)


def warmup() -> dict:
    """Load the model into memory (same context size as real chats, so Ollama does not reload it later)."""
    try:
        _call("/api/chat", {"model": model(), "messages": [], "keep_alive": KEEP_ALIVE, "options": {"num_ctx": NUM_CTX}}, 120.0)
        return {"loaded": True}
    except RequestError as err:
        return {"loaded": False, "error": {"code": err.code, "message": err.message}}


def validate_history(raw) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise RequestError(INVALID_PAYLOAD, "'messages' must be a non-empty list.")
    out = []
    for item in raw:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant") or not isinstance(item.get("content"), str):
            raise RequestError(INVALID_PAYLOAD, "Each message needs a 'role' (user or assistant) and text 'content'.")
        content = item["content"].strip()
        if content:
            out.append({"role": item["role"], "content": content[:MAX_MESSAGE_CHARS]})
    if not out or out[-1]["role"] != "user":
        raise RequestError(INVALID_PAYLOAD, "The last message must be from the user.")
    return out


def warmup_in_background() -> None:
    """Called once when the backend starts: loads qwen3:4b in a background thread (never blocks or breaks startup).
    Skipped in automated tests (FIDEX_BACKEND_TEST=1) or when FIDEX_NO_WARMUP=1."""
    if os.environ.get("FIDEX_BACKEND_TEST") == "1" or os.environ.get("FIDEX_NO_WARMUP") == "1":
        return

    def run():
        try:
            log.info("startup warm-up: %s", warmup())
        except Exception:  # noqa: BLE001
            log.exception("startup warm-up failed")

    threading.Thread(target=run, name="fidex-warmup", daemon=True).start()
