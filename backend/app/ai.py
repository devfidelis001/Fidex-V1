"""Local AI brain: talks to Ollama (http://127.0.0.1:11435) using the qwen3.5:4b model.

Uses only the Python standard library, so no new packages are needed. Settings can be changed
with environment variables:

    FIDEX_OLLAMA_HOST    default http://127.0.0.1:11435
    FIDEX_OLLAMA_MODEL   default qwen3.5:4b
    FIDEX_OLLAMA_TIMEOUT default none: FIDEX AI waits as long as the model needs. A number of seconds (optional)
                         is the longest silence allowed between two pieces of the answer.
"""
from __future__ import annotations

import json
import logging
import os
import queue
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

DEFAULT_HOST = "http://127.0.0.1:11435"  # the bundled engine (same host/port as Electron main, ollama-engine.js)
DEFAULT_MODEL = "qwen3.5:4b"
DEFAULT_TIMEOUT = None  # no limit: a long answer is never cut off by a timer (Stop is the way to cancel)

MAX_HISTORY_MESSAGES = 12  # most recent messages considered as conversation memory
MAX_HISTORY_CHARS = 3000  # budget for recent messages kept in full (newest first)
OLD_SNIPPET_CHARS = 160  # older messages are shortened to this many chars instead of being forgotten
MAX_OLD_CHARS = 800  # total budget for those shortened older messages
MAX_MESSAGE_CHARS = 6000
FULL_PROFILE_CHARS = 1600  # Take Over / Guide Me
MAX_PROFILE_CHARS = 900  # retrieved memories only, never the whole profile
MAX_PAST_CHARS = 2400  # earlier-conversation excerpts the UI found for this question (only sent when the user asked about past chats)
NUM_CTX = 4096  # smaller context = faster prompt processing and less memory
NUM_PREDICT = -1  # no cap: the answer runs until the model finishes (Stop cancels)
NUM_PREDICT_THINK = -1  # no cap in thinking mode either
KEEP_ALIVE = "60m"  # keep the model loaded so there is no reload delay

SYSTEM_PROMPT = (
    "You are FIDEX SI, a personal SI agent on the user's Windows computer. "
    "Reply in the user's language. Answer exactly what was asked, directly, in at most 2 short sentences; "
    "give more only if the user asks for detail. Start with the answer: no preamble, no tips or suggestions, "
    "no background or history, no explanations or caveats nobody asked for, no markdown, no closing offers or questions. "
    "If unsure, say so. Use earlier conversation and what is known about the user only when it is needed for the answer."
)
NO_THINK = "/no_think"  # Qwen 3's own switch; backs up think=false on Ollama builds that ignore that field (qwen3.5 has no such switch)
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # Ollama is local: never route it through a system proxy

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def host() -> str:
    return os.environ.get("FIDEX_OLLAMA_HOST", DEFAULT_HOST).rstrip("/")


_MODEL_CACHE = {"t": 0.0, "name": None}


def installed_models() -> list:
    try:
        tags = _call("/api/tags", None, 3.0)
    except Exception:
        return []
    return [m.get("name", "") for m in tags.get("models", []) if isinstance(m, dict) and m.get("name")]


def model() -> str:
    """FIDEX_OLLAMA_MODEL if set; otherwise the model that is REALLY installed (qwen3.5:4b first, then any qwen3.5, then any)."""
    env = os.environ.get("FIDEX_OLLAMA_MODEL")
    if env:
        return env
    now = time.time()
    if _MODEL_CACHE["name"] and now - _MODEL_CACHE["t"] < 10:
        return _MODEL_CACHE["name"]
    names = installed_models()
    if names:
        pick = next((n for n in (DEFAULT_MODEL, DEFAULT_MODEL + ":latest") if n in names), None) or next((n for n in names if n.lower().startswith("qwen3.5")), names[0])
        _MODEL_CACHE.update(t=now, name=pick)
        return pick
    return DEFAULT_MODEL


def _soft_switch() -> bool:
    """qwen3 understands the /no_think text switch; qwen3.5 does not (it relies on think=false only)."""
    return not model().lower().startswith("qwen3.5")


def _options(think: bool, num_predict: int | None = None) -> dict:
    return {
        "num_ctx": NUM_CTX,  # constant on purpose: a different value makes Ollama reload the model
        "num_predict": num_predict or (NUM_PREDICT_THINK if think else NUM_PREDICT),
        "temperature": 0.6 if think else 0.5,
        "top_k": 20,
        "top_p": 0.95 if think else 0.85,
        "repeat_penalty": 1.05,
    }


def _timeout() -> float | None:
    """None = wait indefinitely (the default). Only an explicit positive FIDEX_OLLAMA_TIMEOUT sets a limit."""
    return None  # chat answers never time out


def _call(path: str, body: dict | None, timeout: float | None) -> dict:
    url = host() + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = json.loads(err.read().decode("utf-8", "replace")).get("error", "")
        except Exception:
            pass
        if err.code == 404 or "not found" in detail.lower():
            raise RequestError(AI_MODEL_MISSING, f"The AI model '{model()}' is not installed. FIDEX SI imports its model pack (FIDEX-SI-Model-qwen3.5-4b.zip) automatically; restart FIDEX SI with the pack next to the app") from None
        log.warning("ollama http error %s: %s", err.code, detail)
        raise RequestError(AI_ERROR, f"The AI engine returned an error ({err.code}). {detail}".strip()) from None
    except (socket.timeout, TimeoutError):
        raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.") from None
    except urllib.error.URLError as err:
        if isinstance(err.reason, (socket.timeout, TimeoutError)):
            raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.") from None
        raise RequestError(AI_UNAVAILABLE, "Cannot reach the FIDEX SI AI engine on 127.0.0.1:11435. FIDEX SI is restarting it automatically; try again in a few seconds.") from None
    except (ConnectionError, OSError):
        raise RequestError(AI_UNAVAILABLE, "Cannot reach the FIDEX SI AI engine on 127.0.0.1:11435. FIDEX SI is restarting it automatically; try again in a few seconds.") from None
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
    out["models"] = names_all = [m.get("name", "") for m in tags.get("models", []) if isinstance(m, dict)]
    out["model"] = model()
    want = model()
    out["model_installed"] = any(n == want or n == want + ":latest" or (":" not in want and n.startswith(want + ":")) for n in names)
    return out


def _shorten(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= OLD_SNIPPET_CHARS else text[:OLD_SNIPPET_CHARS].rstrip() + "..."


PAST_INTRO = (
    "The user is asking about an earlier conversation. These excerpts come from their saved chats. "
    "Answer accurately from them only; quote or paraphrase what was actually said or decided, and do not invent details. "
    "If they do not contain the answer, say you could not find it in the saved chats. You may use a few more sentences than usual."
)


def build_messages(history: list[dict], profile: str = "", profile_limit: int = MAX_PROFILE_CHARS, system: str | None = None, think: bool = False, past_chats: str = "", screen: str = "") -> list[dict]:
    """System prompt (+ saved user details) followed by the conversation: recent messages in full,
    older ones shortened (so facts stay remembered) within a small budget."""
    system = system or SYSTEM_PROMPT
    if profile:
        system += "\n\nUser details:\n" + profile[:profile_limit]
    if past_chats:  # only present when the user asked about earlier conversations
        system += "\n\n" + PAST_INTRO + "\nEarlier conversations:\n" + past_chats[:MAX_PAST_CHARS]
    if screen:  # what the Eye sees right now: the ONLY source for answers about the screen
        system += "\n\n" + screen
    if not think and _soft_switch():
        system += "\n" + NO_THINK
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
        "You are FIDEX AI in Take Over mode, working on a task the user assigned. Do not think out loud and do not narrate what you do. Ask a question ONLY when a needed fact is missing. "
        "NEVER ask for approval or permission: the user already allowed everything. "
        "FIDEX AI has real Windows Hands tools: it can move the mouse, click, scroll, type, press keys and open apps through PyAutoGUI, with no approval question. "
        "Requests to do those things are executed by the Hands engine, not by you: never say you cannot control the mouse or keyboard, create folders/files, click or open things, and never offer to write a Python script for it. Ignore any earlier reply of yours that said you could not: you can. "
        "Never claim you did something unless a real result says so. Plain text only. Reply in ONE very short sentence (under 12 words)."
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
        self.reasoned = ""  # text seen inside <think> blocks (only handed on when the caller asks for it)

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = ""
        while True:
            tag = self.CLOSE if self.inside else self.OPEN
            i = self.buf.find(tag)
            if i >= 0:
                if not self.inside:
                    out += self.buf[:i]
                else:
                    self.reasoned += self.buf[:i]
                self.buf, self.inside = self.buf[i + len(tag):], not self.inside
                continue
            keep = 0  # hold back a possible partial tag at the end
            for n in range(min(len(tag) - 1, len(self.buf)), 0, -1):
                if tag.startswith(self.buf[-n:]):
                    keep = n
                    break
            if not self.inside:
                out += self.buf[: len(self.buf) - keep]
            else:
                self.reasoned += self.buf[: len(self.buf) - keep]
            self.buf = self.buf[len(self.buf) - keep:]
            return out

    def flush(self) -> str:
        out = "" if self.inside else self.buf
        self.buf = ""
        return out


class _Stream:
    """One running (or queued) streamed answer that the user can stop."""

    def __init__(self):
        self.event = threading.Event()
        self.resp = None


_streams: dict[str, _Stream] = {}
_streams_lock = threading.Lock()


def _register(stream_id: str) -> _Stream | None:
    if not stream_id:
        return None
    with _streams_lock:
        return _streams.setdefault(stream_id, _Stream())  # a Stop that arrived first is already marked


def _unregister(stream_id: str) -> None:
    if stream_id:
        with _streams_lock:
            _streams.pop(stream_id, None)


def _kill_resp(resp) -> None:
    """Best effort, never raises and NEVER blocks: drops the connection to Ollama so it stops generating.
    Closing a buffered response while another thread is blocked reading it waits for that read (seconds), so the
    raw socket is shut down and closed directly, and the buffered close runs on a throwaway thread."""
    if resp is None:
        return
    try:
        sock = resp.fp.raw._sock
    except Exception:  # noqa: BLE001
        sock = None
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except Exception:  # noqa: BLE001
            pass
        try:
            sock.close()
        except Exception:  # noqa: BLE001
            pass

    def close() -> None:
        try:
            resp.close()
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=close, name="fidex-ollama-close", daemon=True).start()


def cancel(stream_id: str) -> dict:
    """Stop a streamed answer at once. The generation thread notices within ~50 ms and returns (freeing the
    generation lock); the connection to Ollama is dropped too, so the model stops writing."""
    with _streams_lock:
        stream = _streams.setdefault(stream_id, _Stream())
        if len(_streams) > 64:  # forgotten early Stops must not pile up
            for key in [k for k, v in _streams.items() if v.resp is None and k != stream_id][:32]:
                _streams.pop(key, None)
    stream.event.set()
    _kill_resp(stream.resp)
    return {"cancelled": True}


def _timings(result: dict, wall: float, think: bool = False) -> dict:
    ms = lambda k: round((result.get(k) or 0) / 1e6)  # noqa: E731  (Ollama reports nanoseconds)
    return {
        "load_ms": ms("load_duration"),  # model loading (0 when already in memory)
        "prompt_ms": ms("prompt_eval_duration"),  # reading the prompt
        "generate_ms": ms("eval_duration"),  # writing the answer
        "ollama_total_ms": ms("total_duration"),
        "total_ms": round(wall * 1000),  # as seen by the Python backend
        "prompt_tokens": result.get("prompt_eval_count") or 0,
        "reply_tokens": result.get("eval_count") or 0,
        "thinking": think,
    }


def _ask(messages: list[dict], think: bool = False) -> tuple[str, dict]:
    body = {
        "model": model(),
        "messages": messages,
        "stream": False,
        "think": think,  # False by default: Qwen answers straight away; True only when explicitly requested
        "keep_alive": KEEP_ALIVE,
        "options": _options(think),
    }
    started = time.monotonic()
    result = _call("/api/chat", body, _timeout())
    message = result.get("message") if isinstance(result, dict) else None
    text = clean_reply(message.get("content", "") if isinstance(message, dict) else "")
    return text, _timings(result if isinstance(result, dict) else {}, time.monotonic() - started, think) | {"model": (result or {}).get("model", model())}


def _stream_ask(messages: list[dict], on_token, on_phase=lambda name: None, think: bool = False, stream: _Stream | None = None, on_reasoning=None, num_predict: int | None = None, model_name: str | None = None) -> tuple[str, dict]:
    """Like _ask, but Ollama streams the answer; each visible piece goes to on_token at once.
    The final answer only uses message.content. The model's own reasoning (message.thinking / <think> blocks) is
    dropped, unless on_reasoning is given (Take Over): then it is handed to that callback for display only, never saved."""
    body = {
        "model": model_name or model(), "messages": messages, "stream": True, "think": think, "keep_alive": KEEP_ALIVE,
        "options": _options(think, num_predict),
    }
    req = urllib.request.Request(host() + "/api/chat", data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
    started, parts, final, filt = time.monotonic(), [], {}, _ThinkFilter()
    reasoning_seen, first_ms = False, None
    stopped = lambda: stream is not None and stream.event.is_set()  # noqa: E731
    lines: queue.Queue = queue.Queue()

    def reader() -> None:
        """Reads Ollama's answer on its own thread, so the generation thread never sits in a blocking socket read
        that Stop could fail to wake (a socket shutdown from another thread behaves differently per platform)."""
        resp = None
        try:
            with _OPENER.open(req, timeout=_timeout()) as resp:  # no timeout by default: wait as long as the model needs
                if stream is not None:
                    stream.resp = resp
                    if stopped():  # Stop arrived while the connection was opening
                        _kill_resp(resp)
                        return
                for raw in resp:
                    lines.put(("line", raw))
                    if stopped():
                        break
            lines.put(("end", None))
        except BaseException as err:  # noqa: BLE001  (handed to the generation thread, which translates it)
            lines.put(("err", err))

    try:
        try:
            threading.Thread(target=reader, name="fidex-ollama-read", daemon=True).start()
            while True:
                try:
                    kind, value = lines.get(timeout=0.05)
                except queue.Empty:
                    if stopped():
                        break
                    continue
                if stopped() or kind == "end":
                    break
                if kind == "err":
                    raise value
                raw = value.strip()
                if not raw:
                    continue
                obj = json.loads(raw.decode("utf-8"))
                if obj.get("error"):
                    raise RequestError(AI_ERROR, f"The AI engine returned an error. {obj['error']}")
                msg = obj.get("message") or {}
                if (msg.get("thinking") or (filt.inside and msg.get("content"))) and not reasoning_seen and not parts:
                    reasoning_seen = True
                    if not think:
                        log.warning("the model produced reasoning although think=false; update Ollama (think needs 0.9+)")
                    on_phase("reasoning")  # the model is working
                if on_reasoning and msg.get("thinking"):
                    on_reasoning(msg["thinking"])
                piece = filt.feed(msg.get("content") or "")
                if filt.reasoned:
                    if on_reasoning:
                        on_reasoning(filt.reasoned)
                    filt.reasoned = ""
                if piece:
                    if not parts:
                        piece = piece.lstrip()
                    if piece:
                        if first_ms is None:
                            first_ms = round((time.monotonic() - started) * 1000)  # request sent -> first visible token
                        parts.append(piece)
                        on_token(piece)
                if obj.get("done"):
                    final = obj
                    break
            if stopped():
                _kill_resp(stream.resp)  # make sure Ollama stops, even if the reader was still connecting
            else:
                tail = filt.flush()
                if tail:
                    parts.append(tail)
                    on_token(tail)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                raise RequestError(AI_MODEL_MISSING, f"The AI model '{model()}' is not installed. FIDEX SI imports its model pack (FIDEX-SI-Model-qwen3.5-4b.zip) automatically; restart FIDEX SI with the pack next to the app") from None
            raise RequestError(AI_ERROR, f"The AI engine returned an error ({err.code}).") from None
        except (socket.timeout, TimeoutError):
            raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.") from None
        except (urllib.error.URLError, ConnectionError, OSError):
            raise RequestError(AI_UNAVAILABLE, "Cannot reach the FIDEX SI AI engine on 127.0.0.1:11435. FIDEX SI is restarting it automatically; try again in a few seconds.") from None
        except ValueError:
            raise RequestError(AI_ERROR, "The AI engine sent an unreadable answer.") from None
    except RequestError:
        if not stopped():  # a connection torn down by Stop is not an error
            raise
    text = clean_reply("".join(parts))
    return text, _timings(final, time.monotonic() - started, think) | {"model": final.get("model", model()), "reasoning_leaked": reasoning_seen and not think, "first_token_ms": first_ms, "cancelled": stopped()}


SCREEN_QUESTION = re.compile(
    r"\b(screen|display|monitor|desktop|currently open|(what|which)\b.{0,40}\b(app|apps|application|applications|window|windows|program|tab)\b.{0,30}\b(open|running|active|showing|visible|using)"
    r"|look at|can you see|what do you see|what am i (doing|looking))\b", re.I)
ACTIVE_ONLY = re.compile(r"\b(active|focus(ed)?|foreground|in front|current(ly)?)\b.{0,40}\b(app|application|window|program)\b|\b(app|application|window|program)\b.{0,40}\b(active|focus(ed)?|foreground|in front)\b", re.I)
SEE_WORDS = re.compile(r"\b(describe|read|text|what else|everything|all (the )?(apps|windows)|list)\b", re.I)
SCREEN_WAIT = float(os.environ.get("FIDEX_SCREEN_WAIT", "25"))  # seconds a screen question may wait for the Eye's first look


def screen_context(question: str) -> str:
    """Eye -> brain link for chat answers. Returns the text the model must use to answer about the screen.
    A normal question gets the Eye's fresh description only if vision is already running (never delays it).
    A question ABOUT the screen switches the Eye on, waits for a current look, and never lets the model guess."""
    try:
        from . import vision  # noqa: PLC0415

        asks = bool(SCREEN_QUESTION.search(question or ""))
        if not asks:
            ctx = vision.context()
            return ("Screen (from the Eye, use only if relevant): " + ctx) if ctx else ""
        win = vision.active_window_text()
        if win and ACTIVE_ONLY.search(question or "") and not SEE_WORDS.search(question or ""):  # instant: Windows itself knows the active window
            return f"Exact fact from Windows about the user's real screen right now: {win} Answer from this only, in one plain sentence naming the app."
        text = vision.look_now()
        head = f"Exact fact from Windows: {win} " if win else ""
        if text or win:
            return "The Eye is looking at the user's real screen. Answer ONLY from this, in plain words, naming the real application and window. " + head + (f"Screen description: {text}" if text else "")
        st = vision.status()
        reason = (st.get("error") or {}).get("message") if isinstance(st.get("error"), dict) else st.get("error")
        return ("The Eye could not see the screen right now" + (f" ({reason})" if reason else "") + ". Say plainly that you cannot see the screen at the moment. "
                "NEVER invent or guess an application name and never write placeholders in brackets.")
    except Exception:  # noqa: BLE001
        log.exception("screen context failed")
        return ""


def screen_direct(question: str):
    """For a question about the screen: ONE model call. The brain gets the screenshot itself (sharp, 1024 px) instead of a
    description that a first model call wrote for a second call. Returns (system text, jpeg base64) or None to use screen_context()."""
    try:
        from . import vision  # noqa: PLC0415

        if not SCREEN_QUESTION.search(question or "") or (vision.VISION_MODEL and vision.VISION_MODEL != model()):
            return None  # not a screen question, or the eye uses another model than the brain: keep the two-step path
        win = vision.active_window_text()
        if win and ACTIVE_ONLY.search(question or "") and not SEE_WORDS.search(question or ""):
            return None  # instant answer from Windows itself, no image needed
        shot = vision.fresh_jpeg(timeout=1.0, width=vision.ASK_WIDTH)
        if shot is None:
            return None
        head = f"Exact fact from Windows: {win} " if win else ""
        return ("The attached image is the user's real screen right now. Answer ONLY from it, in plain words, naming the real application and window. Read text exactly. " + head), shot[0]
    except Exception:  # noqa: BLE001
        log.exception("direct screen read failed")
        return None


def chat_stream(history: list[dict], profile: str = "", mode: str = "chat", on_token=lambda t: None, on_stage=lambda t: None, think: bool = False, stream_id: str = "", past_chats: str = "", on_reasoning=None) -> dict:
    """Streaming version of chat(): same memory rules per mode, tokens delivered through on_token.
    Every mode answers without extended thinking (think=false) unless think=True is explicitly passed, and without
    any extra AI call, so the first token is the start of the real answer. on_stage is kept for compatibility but is no longer used."""
    if mode not in memory.MODES:
        raise RequestError(INVALID_PAYLOAD, f"'mode' must be one of: {', '.join(memory.MODES)}.")
    if profile:
        try:
            memory.sync_profile(profile)
        except RequestError as err:
            log.warning("profile sync failed: %s", err.message)
    question = history[-1]["content"]
    context = memory.relevant(question, mode)
    direct = screen_direct(question) if mode == "chat" else None
    build = lambda scr: build_messages(history, context, MAX_PROFILE_CHARS if mode == "chat" else FULL_PROFILE_CHARS, AGENT_PROMPTS.get(mode), think, past_chats, scr)  # noqa: E731
    messages = build(direct[0] if direct else screen_context(question))
    if direct:
        messages[-1]["images"] = [direct[1]]
    stream = _register(stream_id)
    text, timings, got_lock = "", None, False
    _yield_vision()
    try:
        while not got_lock:
            got_lock = _gen_lock.acquire(timeout=0.1)  # queued behind another answer: a Stop must still work
            if not got_lock and stream is not None and stream.event.is_set():
                break
        if got_lock:
            try:
                try:
                    text, timings = _stream_ask(messages, on_token, think=think, stream=stream, on_reasoning=on_reasoning)
                except RequestError as err:
                    if not direct or err.code in (AI_UNAVAILABLE, AI_MODEL_MISSING):
                        raise
                    log.warning("direct screen read failed (%s); using the description path", err.message)
                    messages = build(screen_context(question))  # one retry the old way
                    text, timings = _stream_ask(messages, on_token, think=think, stream=stream, on_reasoning=on_reasoning)
            finally:
                _gen_lock.release()
        else:
            timings = _timings({}, 0.0, think) | {"model": model(), "cancelled": True}
    finally:
        _unregister(stream_id)
    if timings.get("cancelled"):
        log.info("chat stream stopped by the user after %s chars", len(text))
        return {"text": text, "model": timings.pop("model"), "remembered_messages": len(messages) - 1, "timings": timings, "memory_saved": 0, "mode": mode, "cancelled": True}
    if not text:
        raise RequestError(AI_ERROR, "The AI returned an empty answer. Try asking again.")
    saved = memory.learn(question)  # only the user's own durable facts; reasoning is never stored
    log.info("chat stream timings %s", timings)
    return {"text": text, "model": timings.pop("model"), "remembered_messages": len(messages) - 1, "timings": timings, "memory_saved": len(saved), "mode": mode}


def _chat_once(history: list[dict], mode: str = "chat", think: bool = False, past_chats: str = "") -> dict:
    question = history[-1]["content"]
    messages = build_messages(history, memory.relevant(question, mode), MAX_PROFILE_CHARS if mode == "chat" else FULL_PROFILE_CHARS, think=think, past_chats=past_chats, screen=screen_context(question))
    text, timings = _ask(messages, think)
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
def _yield_vision() -> None:
    """Live Vision never makes a chat answer wait: its in-flight analysis is cancelled first."""
    try:
        from . import vision  # noqa: PLC0415

        vision.yield_to_brain()
    except Exception:  # noqa: BLE001
        pass


_gen_lock = threading.Lock()  # one answer at a time: two at once on a small local model each run at half speed


def chat(history: list[dict], profile: str = "", mode: str = "chat", think: bool = False, past_chats: str = "") -> dict:
    if mode not in memory.MODES:
        raise RequestError(INVALID_PAYLOAD, f"'mode' must be one of: {', '.join(memory.MODES)}.")
    if profile:
        try:
            memory.sync_profile(profile)  # instant when unchanged
        except RequestError as err:
            log.warning("profile sync failed: %s", err.message)
    key = (mode, think, len(history), history[-1]["content"], past_chats)
    with _inflight_lock:
        flight = _inflight.get(key)
        leader = flight is None
        if leader:
            flight = _inflight[key] = _Flight()
    if not leader:  # the identical question is already being answered (double send): share that answer
        flight.done.wait()  # no timer: the answer is shared as soon as the first request finishes
        if flight.error:
            raise flight.error
        if flight.result is None:
            raise RequestError(AI_TIMEOUT, "The AI took too long to answer. Try a shorter question or try again.")
        return flight.result
    try:
        _yield_vision()
        with _gen_lock:
            flight.result = _chat_once(history, mode, think, past_chats)
        return flight.result
    except RequestError as err:
        flight.error = err
        raise
    finally:
        flight.done.set()
        with _inflight_lock:
            _inflight.pop(key, None)


_warm_lock = threading.Lock()
_warm_ready = False


def warmup(force: bool = False) -> dict:
    """Load the model into memory (same context size as real chats, so Ollama does not reload it later).
    Idempotent: a second call (startup hook + Electron) waits for the first and reuses its result instead of loading again."""
    global _warm_ready
    with _warm_lock:
        if _warm_ready and not force:
            return {"loaded": True, "cached": True}
        try:
            _call("/api/chat", {"model": model(), "messages": [], "keep_alive": KEEP_ALIVE, "options": {"num_ctx": NUM_CTX}}, 120.0)
            _warm_ready = True
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
    """Called once when the backend starts: loads the model in a background thread (never blocks or breaks startup).
    Skipped in automated tests (FIDEX_BACKEND_TEST=1) or when FIDEX_NO_WARMUP=1."""
    if os.environ.get("FIDEX_BACKEND_TEST") == "1" or os.environ.get("FIDEX_NO_WARMUP") == "1":
        return

    def run():
        try:
            log.info("startup warm-up: %s", warmup())
        except Exception:  # noqa: BLE001
            log.exception("startup warm-up failed")

    threading.Thread(target=run, name="fidex-warmup", daemon=True).start()
