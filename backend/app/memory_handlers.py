"""Memory requests: review, add, edit, delete and search the permanent memory.

    memory.list    {category?, query?}          -> {memories:[...]}
    memory.add     {category, content, key?}    -> memory
    memory.update  {id, content?, category?}     -> memory
    memory.delete  {id}                          -> {deleted}
    memory.search  {query, mode?}                     -> {text}   (what would be sent to the AI for that question)
    memory.stats   {}                            -> {total, by_category, db_path}
"""
from __future__ import annotations

from . import memory
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError


def _only(payload: dict, allowed: tuple) -> None:
    for key in payload:
        if key not in allowed:
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")


def _id(payload: dict) -> int:
    v = payload.get("id")
    if not isinstance(v, int) or isinstance(v, bool):
        raise RequestError(INVALID_PAYLOAD, "'id' must be a whole number.")
    return v


@handler("memory.list")
def memory_list(payload: dict) -> dict:
    _only(payload, ("category", "query"))
    cat = payload.get("category")
    if cat is not None:
        memory._check_category(cat)
    q = payload.get("query", "")
    if not isinstance(q, str):
        raise RequestError(INVALID_PAYLOAD, "'query' must be text.")
    return {"memories": memory.list_all(cat, q), "categories": list(memory.CATEGORIES)}


@handler("memory.add")
def memory_add(payload: dict) -> dict:
    _only(payload, ("category", "content", "key"))
    key = payload.get("key") or ""
    if not isinstance(key, str):
        raise RequestError(INVALID_PAYLOAD, "'key' must be text.")
    return memory.upsert(payload.get("category", "fact"), key, payload.get("content"), "user")


@handler("memory.update")
def memory_update(payload: dict) -> dict:
    _only(payload, ("id", "content", "category"))
    return memory.update(_id(payload), payload.get("content"), payload.get("category"))


@handler("memory.delete")
def memory_delete(payload: dict) -> dict:
    _only(payload, ("id",))
    return memory.delete(_id(payload))


@handler("memory.search")
def memory_search(payload: dict) -> dict:
    _only(payload, ("query", "mode"))
    q = payload.get("query")
    if not isinstance(q, str):
        raise RequestError(INVALID_PAYLOAD, "'query' must be text.")
    mode = payload.get("mode", "chat")
    return {"text": memory.relevant(q, mode if isinstance(mode, str) else "")}


@handler("agent.context")
def agent_context(payload: dict) -> dict:
    """Relevant full permanent memory for Take Over / Guide Me (mode: takeover | guide)."""
    _only(payload, ("query", "mode"))
    q, mode = payload.get("query", ""), payload.get("mode", "takeover")
    if not isinstance(q, str) or mode not in ("takeover", "guide"):
        raise RequestError(INVALID_PAYLOAD, "'query' must be text and 'mode' must be takeover or guide.")
    return {"mode": mode, "text": memory.relevant(q, mode)}


@handler("memory.stats")
def memory_stats(payload: dict) -> dict:
    return memory.stats()


@handler("memory.forget")
def memory_forget(payload: dict) -> dict:
    """Remove chat-learned facts and/or copies of the saved details. {scope: chat|profile|all}"""
    _only(payload, ("scope",))
    return memory.forget(payload.get("scope") or "chat")


@handler("chat.remember")
def chat_remember(payload: dict) -> dict:
    """After a direct (no-Python) chat answer: mirror the profile, learn durable facts, return the memory text for the next question."""
    _only(payload, ("text", "profile"))
    profile, text = payload.get("profile"), payload.get("text", "")
    text = text if isinstance(text, str) else ""
    if isinstance(profile, str) and profile.strip():
        try:
            memory.sync_profile(profile)
        except RequestError:
            pass
    if text.strip():
        memory.learn(text)
    return {"memory": memory.relevant(text, "chat")[:900]}
