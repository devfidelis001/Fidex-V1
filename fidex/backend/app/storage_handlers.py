"""Request types for local storage (Step 5). The interface reaches the database ONLY through
these, via window.fidex.backendRequest(type, payload).

    db.status
    conversation.create | .get | .list | .update | .delete
    message.create      | .get | .list | .update | .delete
    task.create         | .get | .list | .update | .delete

Step 6 (automatic save progress):
    work.save | work.restore | work.resume | work.discard | work.context.add

Unknown payload fields are rejected (a typo must not silently do nothing). Answers are plain
JSON. No SQL, file path or SQLite message ever appears in a response.
"""
from __future__ import annotations

from typing import Iterable

from . import progress
from .handlers import handler
from .protocol import INVALID_PAYLOAD, RequestError
from .storage import storage


def _only(payload: dict, allowed: Iterable[str], required: Iterable[str] = ()) -> dict:
    allowed = set(allowed)
    for key in payload:
        if key not in allowed:
            raise RequestError(INVALID_PAYLOAD, f"Unknown field '{key}'.")
    for key in required:
        if key not in payload:
            raise RequestError(INVALID_PAYLOAD, f"Missing field '{key}'.")
    return payload


# ----- status -----
@handler("db.status")
def db_status(payload: dict) -> dict:
    _only(payload, ())
    return storage.get().status()


# ----- conversations -----
@handler("conversation.create")
def conversation_create(payload: dict) -> dict:
    _only(payload, ("title", "id"))
    return storage.get().create_conversation(payload.get("title"), payload.get("id"))


@handler("conversation.get")
def conversation_get(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return storage.get().get_conversation(payload["id"])


@handler("conversation.list")
def conversation_list(payload: dict) -> dict:
    _only(payload, ("limit", "offset"))
    return storage.get().list_conversations(payload.get("limit"), payload.get("offset"))


@handler("conversation.update")
def conversation_update(payload: dict) -> dict:
    _only(payload, ("id", "title"), ("id", "title"))
    return storage.get().update_conversation(payload["id"], payload["title"])


@handler("conversation.delete")
def conversation_delete(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return storage.get().delete_conversation(payload["id"])


# ----- messages -----
@handler("message.create")
def message_create(payload: dict) -> dict:
    _only(payload, ("conversation_id", "role", "content", "id"), ("conversation_id", "role", "content"))
    return storage.get().create_message(payload["conversation_id"], payload["role"], payload["content"], payload.get("id"))


@handler("message.get")
def message_get(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return storage.get().get_message(payload["id"])


@handler("message.list")
def message_list(payload: dict) -> dict:
    _only(payload, ("conversation_id", "limit", "offset"), ("conversation_id",))
    return storage.get().list_messages(payload["conversation_id"], payload.get("limit"), payload.get("offset"))


@handler("message.update")
def message_update(payload: dict) -> dict:
    _only(payload, ("id", "content"), ("id", "content"))
    return storage.get().update_message(payload["id"], payload["content"])


@handler("message.delete")
def message_delete(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return storage.get().delete_message(payload["id"])


# ----- tasks -----
@handler("task.create")
def task_create(payload: dict) -> dict:
    _only(payload, ("title", "description", "status", "conversation_id", "id"), ("title",))
    return storage.get().create_task(
        payload["title"], payload.get("description"), payload.get("status"), payload.get("conversation_id"), payload.get("id")
    )


@handler("task.get")
def task_get(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return storage.get().get_task(payload["id"])


@handler("task.list")
def task_list(payload: dict) -> dict:
    _only(payload, ("status", "conversation_id", "limit", "offset"))
    return storage.get().list_tasks(payload.get("status"), payload.get("conversation_id"), payload.get("limit"), payload.get("offset"))


@handler("task.update")
def task_update(payload: dict) -> dict:
    _only(payload, ("id", "title", "description", "status"), ("id",))
    fields = {k: v for k, v in payload.items() if k != "id"}
    return storage.get().update_task(payload["id"], fields)


@handler("task.delete")
def task_delete(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return storage.get().delete_task(payload["id"])


# ----- Step 6: automatic save progress -----
@handler("work.save")
def work_save(payload: dict) -> dict:
    return progress.save(storage.get(), payload)


@handler("work.restore")
def work_restore(payload: dict) -> dict:
    _only(payload, ())
    db = storage.get()  # opening it (first time) also fixes previous_ended_cleanly
    return progress.restore(db, storage.previous_ended_cleanly)


@handler("work.resume")
def work_resume(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return progress.resume(storage.get(), payload["id"])


@handler("work.discard")
def work_discard(payload: dict) -> dict:
    _only(payload, ("id",), ("id",))
    return progress.discard(storage.get(), payload["id"])


@handler("work.context.add")
def work_context_add(payload: dict) -> dict:
    _only(payload, ("kind", "content", "task_id"), ("kind", "content"))
    return progress.add_context(storage.get(), payload["kind"], payload["content"], payload.get("task_id"))
