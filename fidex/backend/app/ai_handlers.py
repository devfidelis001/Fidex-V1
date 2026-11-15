"""Request types for the AI brain (Ollama + qwen3:4b).

    chat.reply   {messages:[{role,content}...], profile?: str, mode?: "chat"|"takeover"|"guide"}  ->  {text, model, remembered_messages}
    ai.status    {}                                              ->  {host, model, reachable, model_installed}
"""
from __future__ import annotations

from . import ai
from .handlers import emit, handler
from .protocol import INVALID_PAYLOAD, RequestError


@handler("chat.reply")
def chat_reply(payload: dict) -> dict:
    for key in payload:
        if key not in ("messages", "profile", "mode"):
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")
    profile = payload.get("profile", "")
    if not isinstance(profile, str):
        raise RequestError(INVALID_PAYLOAD, "'profile' must be text.")
    mode = payload.get("mode", "chat")
    return ai.chat(ai.validate_history(payload.get("messages")), profile.strip(), mode if isinstance(mode, str) else "")


@handler("ai.status")
def ai_status(payload: dict) -> dict:
    return ai.status()


@handler("ai.warmup")
def ai_warmup(payload: dict) -> dict:
    """Loads the model into memory ahead of the first question (no reply is generated)."""
    return ai.warmup()


@handler("chat.stream")
def chat_stream(payload: dict) -> dict:
    """Like chat.reply, but sends {event:"chat.token", data:{stream_id, text}} lines while the answer is written.
    The reply carries the final cleaned answer; only that should be saved."""
    for key in payload:
        if key not in ("messages", "profile", "mode", "stream_id"):
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")
    profile = payload.get("profile", "")
    sid = payload.get("stream_id", "")
    mode = payload.get("mode", "chat")
    if not isinstance(profile, str) or not isinstance(sid, str) or len(sid) > 64 or not isinstance(mode, str):
        raise RequestError(INVALID_PAYLOAD, "'profile', 'mode' and 'stream_id' must be text.")
    return ai.chat_stream(ai.validate_history(payload.get("messages")), profile.strip(), mode, lambda t: emit("chat.token", {"stream_id": sid, "text": t}), lambda t: emit("chat.stage", {"stream_id": sid, "text": t}))
