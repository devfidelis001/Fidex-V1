"""Automatic save progress (Step 6): save the working state of a task as it changes, and report it
back after a restart so the user can continue.

Rules this module enforces (on top of the Step 5 rules in database.py):

* ONE transaction per save. A save fully happens or not at all, so a crash mid-save leaves the
  previous saved state intact.
* Saves are idempotent upserts keyed by ids the caller owns (task id, step key, request key) and
  by a content hash for context notes. Repeating a save, or replaying it after a retry, never
  creates a duplicate record.
* Progress only moves forward: a late or out-of-order save cannot lower the progress, move a
  finished step back, reopen an answered question or revive a completed/stopped task.
* Restoring only READS and reports. It never runs anything. An approval that was given but whose
  action was not recorded as executed is NOT carried over as approved: resuming reopens it, so the
  user must approve again. Actions recorded as executed are never offered again.
* The report says exactly what was saved and when. It never claims that work done after the last
  save was recovered.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any, Optional

from .database import (
    MAX_DESCRIPTION_CHARS,
    MAX_TITLE_CHARS,
    Database,
    _bad,
    _check_choice,
    _check_id,
    _check_text,
    _row,
    new_id,
)
from .protocol import NOT_FOUND, RequestError

log = logging.getLogger("fidex.progress")

STEP_STATES = ("pending", "active", "done", "skipped")
REQUEST_KINDS = ("info", "approval")
REQUEST_STATES = ("open", "answered", "skipped")
CONTEXT_KINDS = ("project", "instruction", "decision", "file", "activity", "note")
UNFINISHED = ("pending", "in_progress")
TERMINAL = ("completed", "failed", "cancelled")
TASK_STATUSES = UNFINISHED + TERMINAL

MAX_STEPS = 30
MAX_REQUESTS = 30
MAX_CONTEXT_PER_SAVE = 50
MAX_CONTEXT_PER_TASK = 300
MAX_RESTORE_TASKS = 20
KEEP_SESSIONS = 20

_STATE_RANK = {"pending": 0, "active": 1, "done": 2, "skipped": 2}
_REQUEST_RANK = {"open": 0, "answered": 1, "skipped": 1}

_SAVE_FIELDS = {"id", "title", "instruction", "status", "progress", "phase", "activity", "steps", "requests", "context"}
_STEP_FIELDS = {"key", "label", "state"}
_REQUEST_FIELDS = {"key", "kind", "text", "detail", "state", "answer", "consequential", "executed"}
_CONTEXT_FIELDS = {"kind", "content"}

_TASK_SELECT = (
    "SELECT id, conversation_id, title, description, status, created_at, updated_at, completed_at, "
    "progress, phase, instruction, activity, interrupted_at FROM tasks"
)


def _unknown(d: dict, allowed: set, where: str) -> None:
    for key in d:
        if key not in allowed:
            raise _bad(f"Unknown field '{key}' in {where}.")


def _list(value: Any, name: str, limit: int) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise _bad(f"'{name}' must be a list.")
    if len(value) > limit:
        raise _bad(f"'{name}' has more than {limit} entries.")
    return value


def _item(value: Any, name: str, allowed: set) -> dict:
    if not isinstance(value, dict):
        raise _bad(f"Each entry of '{name}' must be an object.")
    _unknown(value, allowed, name)
    return value


def content_key(text: str) -> str:
    """Hash of the text with case and whitespace ignored, so 'Use  Blue' and 'use blue' are one note."""
    return hashlib.sha256(" ".join(text.split()).lower().encode("utf-8")).hexdigest()[:32]


# ----------------------------------------------------------------------------- sessions
def begin_session(db: Database) -> dict:
    """Called once when the backend opens the database.

    Any earlier session that never recorded a clean exit means the backend (or the whole PC) died
    unexpectedly. Unfinished tasks cannot be running in a brand-new process, so they are marked
    interrupted until the user resumes them.
    """
    now = db._clock()
    sid = new_id()
    with db._tx() as conn:
        last = conn.execute("SELECT ended_at, ended_cleanly FROM app_sessions ORDER BY started_at DESC, rowid DESC LIMIT 1").fetchone()
        crashed = conn.execute("SELECT COUNT(*) FROM app_sessions WHERE ended_at IS NULL").fetchone()[0]
        conn.execute("UPDATE app_sessions SET ended_at = ?, ended_cleanly = 0 WHERE ended_at IS NULL", (now,))
        conn.execute("INSERT INTO app_sessions (id, started_at) VALUES (?, ?)", (sid, now))
        conn.execute(
            "DELETE FROM app_sessions WHERE id NOT IN (SELECT id FROM app_sessions ORDER BY started_at DESC, rowid DESC LIMIT ?)",
            (KEEP_SESSIONS,),
        )
        conn.execute(
            "UPDATE tasks SET interrupted_at = ? WHERE status IN ('pending', 'in_progress') AND interrupted_at IS NULL", (now,)
        )
    previous = None if last is None else (False if crashed else bool(last["ended_cleanly"]))
    return {"id": sid, "previous_ended_cleanly": previous}


def end_session(db: Database, sid: str) -> None:
    """Called on a normal shutdown. Never raises: shutdown must not fail because of this."""
    try:
        with db._tx() as conn:
            conn.execute("UPDATE app_sessions SET ended_at = ?, ended_cleanly = 1 WHERE id = ? AND ended_at IS NULL", (db._clock(), sid))
    except Exception as err:  # noqa: BLE001 - best effort by design
        log.warning("could not record a clean shutdown: %s", err)


# ----------------------------------------------------------------------------- save
def save(db: Database, payload: dict) -> dict:
    """Create or update a task together with its steps, requests and context, atomically."""
    _unknown(payload, _SAVE_FIELDS, "the request")
    tid = _check_id(payload.get("id"), "id") if payload.get("id") is not None else None
    if tid is None:
        raise _bad("Missing field 'id'.")
    title = _check_text(payload["title"], "title", max_chars=MAX_TITLE_CHARS, strip=True) if "title" in payload else None
    instruction = (
        _check_text(payload["instruction"], "instruction", max_chars=MAX_DESCRIPTION_CHARS, allow_empty=True) if "instruction" in payload else None
    )
    status = _check_choice(payload["status"], "status", TASK_STATUSES) if "status" in payload else None
    progress = None
    if "progress" in payload:
        p = payload["progress"]
        if isinstance(p, bool) or not isinstance(p, (int, float)) or not 0 <= p <= 100:
            raise _bad("'progress' must be a number from 0 to 100.")
        progress = int(round(p))
    phase = _check_text(payload["phase"], "phase", max_chars=MAX_TITLE_CHARS, allow_empty=True) if payload.get("phase") is not None else None
    activity = _check_text(payload["activity"], "activity", max_chars=MAX_TITLE_CHARS * 2, allow_empty=True) if payload.get("activity") is not None else None

    steps = []
    for i, raw in enumerate(_list(payload.get("steps"), "steps", MAX_STEPS)):
        s = _item(raw, "steps", _STEP_FIELDS)
        steps.append((
            _check_id(s.get("key"), "steps.key"),
            i,
            _check_text(s.get("label"), "steps.label", max_chars=MAX_TITLE_CHARS, strip=True),
            _check_choice(s.get("state"), "steps.state", STEP_STATES),
        ))

    requests = []
    for raw in _list(payload.get("requests"), "requests", MAX_REQUESTS):
        r = _item(raw, "requests", _REQUEST_FIELDS)
        kind = _check_choice(r.get("kind"), "requests.kind", REQUEST_KINDS)
        answer = r.get("answer")
        if answer is not None:
            answer = _check_text(answer, "requests.answer", max_chars=MAX_DESCRIPTION_CHARS, allow_empty=True)
        for flag in ("consequential", "executed"):
            if flag in r and not isinstance(r[flag], bool):
                raise _bad(f"'requests.{flag}' must be true or false.")
        requests.append({
            "key": _check_id(r.get("key"), "requests.key"),
            "kind": kind,
            "text": _check_text(r.get("text"), "requests.text", max_chars=MAX_TITLE_CHARS, strip=True),
            "detail": _check_text(r["detail"], "requests.detail", max_chars=MAX_DESCRIPTION_CHARS, allow_empty=True) if r.get("detail") is not None else "",
            "state": _check_choice(r.get("state"), "requests.state", REQUEST_STATES),
            "answer": answer,
            "consequential": r.get("consequential", kind == "approval"),
            "executed": r.get("executed", False),
        })

    context = []
    for raw in _list(payload.get("context"), "context", MAX_CONTEXT_PER_SAVE):
        c = _item(raw, "context", _CONTEXT_FIELDS)
        text = _check_text(c.get("content"), "context.content", max_chars=MAX_DESCRIPTION_CHARS, strip=True)
        context.append((_check_choice(c.get("kind"), "context.kind", CONTEXT_KINDS), text))

    now = db._clock()
    with db._tx() as conn:
        row = conn.execute(_TASK_SELECT + " WHERE id = ?", (tid,)).fetchone()
        if row is None:
            if title is None:
                raise _bad("A new task needs a 'title'.")
            st = status or "in_progress"
            conn.execute(
                "INSERT INTO tasks (id, title, description, status, created_at, updated_at, completed_at, progress, phase, instruction, activity) "
                "VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)",
                (tid, title, st, now, now, now if st == "completed" else None, progress or 0, phase, instruction or "", activity or ""),
            )
        elif row["status"] in TERMINAL:
            # Finished/stopped tasks are final. A late save must not revive or alter them.
            return {"task": dict(row), "saved": False, "reason": "task_finished"}
        else:
            new_status = status or row["status"]
            new_progress = row["progress"] if progress is None else max(row["progress"], progress)
            conn.execute(
                "UPDATE tasks SET title = ?, status = ?, completed_at = ?, progress = ?, phase = ?, instruction = ?, activity = ?, updated_at = ? WHERE id = ?",
                (
                    title or row["title"],
                    new_status,
                    now if new_status == "completed" else None,
                    new_progress,
                    row["phase"] if phase is None else phase,
                    row["instruction"] if instruction is None else instruction,
                    row["activity"] if activity is None else activity,
                    now,
                    tid,
                ),
            )
        if status in TERMINAL:
            conn.execute("UPDATE tasks SET interrupted_at = NULL WHERE id = ?", (tid,))

        for key, seq, label, state in steps:
            old = conn.execute("SELECT state FROM task_steps WHERE task_id = ? AND step_key = ?", (tid, key)).fetchone()
            if old is None:
                conn.execute("INSERT INTO task_steps (task_id, step_key, seq, label, state, updated_at) VALUES (?, ?, ?, ?, ?, ?)", (tid, key, seq, label, state, now))
            elif _STATE_RANK[state] >= _STATE_RANK[old["state"]]:
                conn.execute("UPDATE task_steps SET seq = ?, label = ?, state = ?, updated_at = ? WHERE task_id = ? AND step_key = ?", (seq, label, state, now, tid, key))

        for r in requests:
            old = conn.execute("SELECT state, executed_at FROM task_requests WHERE task_id = ? AND req_key = ?", (tid, r["key"])).fetchone()
            executed_at = now if r["executed"] else None
            if old is None:
                conn.execute(
                    "INSERT INTO task_requests (task_id, req_key, kind, text, detail, state, answer, consequential, executed_at, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (tid, r["key"], r["kind"], r["text"], r["detail"], r["state"], r["answer"], int(r["consequential"]), executed_at, now, now),
                )
            elif _REQUEST_RANK[r["state"]] >= _REQUEST_RANK[old["state"]]:
                conn.execute(
                    "UPDATE task_requests SET text = ?, detail = ?, state = ?, answer = ?, consequential = ?, executed_at = COALESCE(executed_at, ?), updated_at = ? "
                    "WHERE task_id = ? AND req_key = ?",
                    (r["text"], r["detail"], r["state"], r["answer"], int(r["consequential"]), executed_at, now, tid, r["key"]),
                )

        have = conn.execute("SELECT COUNT(*) FROM work_context WHERE task_id = ?", (tid,)).fetchone()[0]
        for kind, text in context:
            if have >= MAX_CONTEXT_PER_TASK:
                break
            cur = conn.execute(
                "INSERT OR IGNORE INTO work_context (id, task_id, kind, content, content_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (db._new_id(), tid, kind, text, content_key(text), now),
            )
            have += cur.rowcount

        return {"task": dict(conn.execute(_TASK_SELECT + " WHERE id = ?", (tid,)).fetchone()), "saved": True, "saved_at": now}


def add_context(db: Database, kind: Any, content: Any, task_id: Any = None) -> dict:
    """Remember one thing (decision, instruction, file...). ``task_id`` None = applies to the whole project."""
    kind = _check_choice(kind, "kind", CONTEXT_KINDS)
    text = _check_text(content, "content", max_chars=MAX_DESCRIPTION_CHARS, strip=True)
    tid = None if task_id is None else _check_id(task_id, "task_id")
    now = db._clock()
    with db._tx() as conn:
        if tid is not None and not conn.execute("SELECT 1 FROM tasks WHERE id = ?", (tid,)).fetchone():
            raise RequestError(NOT_FOUND, "Task not found.")
        cur = conn.execute(
            "INSERT OR IGNORE INTO work_context (id, task_id, kind, content, content_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (db._new_id(), tid, kind, text, content_key(text), now),
        )
    return {"added": cur.rowcount == 1, "kind": kind, "task_id": tid}


# ----------------------------------------------------------------------------- restore
def _describe(task: dict, steps: list, requests: list, context: list, crashed: Optional[bool]) -> dict:
    stopped_at = next((s for s in steps if s["state"] == "active"), None) or next((s for s in steps if s["state"] == "pending"), None)
    open_requests = [r for r in requests if r["state"] == "open"]
    reapproval = [r for r in requests if r["kind"] == "approval" and r["state"] == "answered" and r["answer"] == "approved" and not r["executed_at"]]
    already_done = [r["text"] for r in requests if r["executed_at"]]
    where = f"It stopped at: {stopped_at['label']}." if stopped_at else "All steps were saved as finished."
    cause = " FIDEX AI closed unexpectedly." if crashed else ""
    return {
        "stopped_at": stopped_at,
        "open_requests": open_requests,
        "needs_reapproval": reapproval,
        "already_done": already_done,
        "decisions": [c["content"] for c in context if c["kind"] == "decision"],
        "summary": f"Last saved {task['updated_at']}, {task['progress']}% complete. {where}{cause} Anything done after the last save was not saved.",
    }


def restore(db: Database, previous_ended_cleanly: Optional[bool] = None) -> dict:
    """Everything needed to offer 'continue': unfinished tasks, where each stopped, and the context.

    Read-only: nothing is started, resumed or executed here.
    """
    crashed = None if previous_ended_cleanly is None else (not previous_ended_cleanly)
    with db._read() as conn:
        tasks = [dict(r) for r in conn.execute(
            _TASK_SELECT + " WHERE status IN ('pending', 'in_progress') ORDER BY updated_at DESC, id LIMIT ?", (MAX_RESTORE_TASKS,)
        ).fetchall()]
        out = []
        for t in tasks:
            tid = t["id"]
            steps = [dict(r) for r in conn.execute(
                "SELECT step_key AS key, seq, label, state, updated_at FROM task_steps WHERE task_id = ? ORDER BY seq", (tid,)).fetchall()]
            requests = [dict(r) for r in conn.execute(
                "SELECT req_key AS key, kind, text, detail, state, answer, consequential, executed_at FROM task_requests WHERE task_id = ? ORDER BY created_at, rowid", (tid,)).fetchall()]
            context = [dict(r) for r in conn.execute(
                "SELECT kind, content, created_at FROM work_context WHERE task_id = ? ORDER BY created_at, rowid", (tid,)).fetchall()]
            t = {**t, "interrupted": t["interrupted_at"] is not None}
            out.append({"task": t, "steps": steps, "requests": requests, "context": context, "resume": _describe(t, steps, requests, context, crashed)})
        shared = [dict(r) for r in conn.execute(
            "SELECT kind, content, created_at FROM work_context WHERE task_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 50").fetchall()]
    return {"previous_session_ended_cleanly": previous_ended_cleanly, "tasks": out, "project_context": shared}


def resume(db: Database, task_id: Any) -> dict:
    """The user chose to continue. Marks the task active again and reopens approvals that were given
    but never recorded as executed. Does NOT execute anything."""
    tid = _check_id(task_id, "id")
    now = db._clock()
    with db._tx() as conn:
        row = conn.execute(_TASK_SELECT + " WHERE id = ?", (tid,)).fetchone()
        if row is None:
            raise RequestError(NOT_FOUND, "Task not found.")
        if row["status"] in TERMINAL:
            raise RequestError(NOT_FOUND, "This task is already finished and cannot be resumed.")
        stale = [dict(r) for r in conn.execute(
            "SELECT req_key, text FROM task_requests WHERE task_id = ? AND kind = 'approval' AND state = 'answered' AND answer = 'approved' AND executed_at IS NULL",
            (tid,)).fetchall()]
        conn.execute(
            "UPDATE task_requests SET state = 'open', answer = NULL, updated_at = ? "
            "WHERE task_id = ? AND kind = 'approval' AND state = 'answered' AND answer = 'approved' AND executed_at IS NULL",
            (now, tid),
        )
        conn.execute("UPDATE tasks SET status = 'in_progress', interrupted_at = NULL, updated_at = ? WHERE id = ?", (now, tid))
        task = dict(conn.execute(_TASK_SELECT + " WHERE id = ?", (tid,)).fetchone())
    return {"task": task, "reopened_approvals": stale, "auto_executed": False}


def discard(db: Database, task_id: Any) -> dict:
    """The user chose not to continue: the task is marked cancelled (kept for history)."""
    tid = _check_id(task_id, "id")
    now = db._clock()
    with db._tx() as conn:
        cur = conn.execute(
            "UPDATE tasks SET status = 'cancelled', completed_at = NULL, interrupted_at = NULL, updated_at = ? "
            "WHERE id = ? AND status IN ('pending', 'in_progress')", (now, tid))
        if cur.rowcount == 0:
            if conn.execute("SELECT 1 FROM tasks WHERE id = ?", (tid,)).fetchone() is None:
                raise RequestError(NOT_FOUND, "Task not found.")
        return {"task": _row(conn.execute(_TASK_SELECT + " WHERE id = ?", (tid,)).fetchone())}
