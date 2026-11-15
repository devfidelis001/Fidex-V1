"""Request types for the AI brain (Ollama + qwen3:4b).

    chat.reply   {messages:[{role,content}...], profile?: str}  ->  {text, model, remembered_messages}
    ai.status    {}                                              ->  {host, model, reachable, model_installed}
"""
from __future__ import annotations

from . import ai
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError


@handler("chat.reply")
def chat_reply(payload: dict) -> dict:
    for key in payload:
        if key not in ("messages", "profile"):
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")
    profile = payload.get("profile", "")
    if not isinstance(profile, str):
        raise RequestError(INVALID_PAYLOAD, "'profile' must be text.")
    return ai.chat(ai.validate_history(payload.get("messages")), profile.strip())


@handler("ai.status")
def ai_status(payload: dict) -> dict:
    return ai.status()


@handler("ai.warmup")
def ai_warmup(payload: dict) -> dict:
    """Loads the model into memory ahead of the first question (no reply is generated)."""
    return ai.warmup()
