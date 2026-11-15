"""Request types for the AI brain (Ollama + qwen3.5:4b).

    chat.reply   {messages:[{role,content}...], profile?: str, past_chats?: str, mode?: "chat"|"takeover"|"guide", think?: bool}  ->  {text, model, remembered_messages}
    chat.stream  {..., stream_id}  ->  streams chat.token events (and chat.reasoning in takeover mode with think: true); chat.cancel {stream_id} stops it at once (reply has cancelled: true)
    ai.status    {}                                              ->  {host, model, reachable, model_installed}
"""
from __future__ import annotations

from . import ai
from .handlers import emit, handler
from .protocol import INVALID_PAYLOAD, RequestError


def _past_chats(payload: dict) -> str:
    """Optional excerpts of earlier conversations. The UI sends them only when the user asked about past chats."""
    value = payload.get("past_chats", "")
    if not isinstance(value, str):
        raise RequestError(INVALID_PAYLOAD, "'past_chats' must be text.")
    return value.strip()[: ai.MAX_PAST_CHARS]


def _think(payload: dict) -> bool:
    """Thinking mode is off unless the request explicitly sends think: true."""
    value = payload.get("think", False)
    if not isinstance(value, bool):
        raise RequestError(INVALID_PAYLOAD, "'think' must be true or false.")
    return value


@handler("chat.reply")
def chat_reply(payload: dict) -> dict:
    for key in payload:
        if key not in ("messages", "profile", "mode", "think", "past_chats"):
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")
    profile = payload.get("profile", "")
    if not isinstance(profile, str):
        raise RequestError(INVALID_PAYLOAD, "'profile' must be text.")
    mode = payload.get("mode", "chat")
    mode = mode if isinstance(mode, str) else ""
    return ai.chat(ai.validate_history(payload.get("messages")), profile.strip(), mode, _think(payload) and mode != "chat", _past_chats(payload))  # Normal Chat: think is always false


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
        if key not in ("messages", "profile", "mode", "stream_id", "think", "past_chats"):
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")
    profile = payload.get("profile", "")
    sid = payload.get("stream_id", "")
    mode = payload.get("mode", "chat")
    if not isinstance(profile, str) or not isinstance(sid, str) or len(sid) > 64 or not isinstance(mode, str):
        raise RequestError(INVALID_PAYLOAD, "'profile', 'mode' and 'stream_id' must be text.")
    think = _think(payload) and mode != "chat"  # Normal Chat always sends think:false to Ollama; Take Over / Guide Me keep their own setting
    # Take Over shows the model's real reasoning while it works (display only: it is never part of the saved answer).
    on_reasoning = (lambda t: emit("chat.reasoning", {"stream_id": sid, "text": t})) if think and mode == "takeover" else None
    return ai.chat_stream(ai.validate_history(payload.get("messages")), profile.strip(), mode, lambda t: emit("chat.token", {"stream_id": sid, "text": t}), lambda t: emit("chat.stage", {"stream_id": sid, "text": t}), think, sid, _past_chats(payload), on_reasoning)


@handler("chat.cancel")
def chat_cancel(payload: dict) -> dict:
    """Stops the chat.stream with this stream_id right away (the partial answer comes back with cancelled: true)."""
    for key in payload:
        if key != "stream_id":
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")
    sid = payload.get("stream_id")
    if not isinstance(sid, str) or not sid or len(sid) > 64:
        raise RequestError(INVALID_PAYLOAD, "'stream_id' must be non-empty text.")
    return ai.cancel(sid)
