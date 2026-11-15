"""Local SQLite storage for FIDEX AI (Step 5): conversations, messages and tasks.

Uses only Python's built-in ``sqlite3``. Design rules:

* Every value reaches SQL through ``?`` parameters. SQL text is never built from input.
* Input is validated here AND constrained by the schema (NOT NULL / CHECK / UNIQUE / FOREIGN KEY),
  so a bug in one layer cannot create a corrupt record.
* Every write runs in one ``BEGIN IMMEDIATE`` transaction: it fully happens or not at all.
* All failures leave this module as ``RequestError`` with a stable code. SQLite's own messages,
  SQL text, record contents and file paths are logged to stderr at most, never sent to the
  interface.
* One connection guarded by a lock. The server runs each request on its own thread, so this
  keeps SQLite access strictly serial.
* A damaged database file is moved aside (never deleted) and replaced by a fresh one.
"""
from __future__ import annotations

import logging
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from .protocol import (
    DB_ERROR,
    DB_UNAVAILABLE,
    DUPLICATE_ID,
    INVALID_PAYLOAD,
    NOT_FOUND,
    RequestError,
)

log = logging.getLogger("fidex.database")

SCHEMA_VERSION = 2

MAX_ID_LENGTH = 64
MAX_TITLE_CHARS = 200
MAX_CONTENT_CHARS = 100_000
MAX_DESCRIPTION_CHARS = 10_000
DEFAULT_LIMIT = 100
MAX_LIMIT = 500
DEFAULT_CONVERSATION_TITLE = "New conversation"

ROLES = ("user", "assistant", "system")
TASK_STATUSES = ("pending", "in_progress", "completed", "failed", "cancelled")

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,%d}$" % (MAX_ID_LENGTH - 1))

# Schema version 1. Each entry is ONE statement (run inside one transaction with the version bump).
_SCHEMA_V1 = (
    f"""
    CREATE TABLE conversations (
        id         TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND {MAX_ID_LENGTH}),
        title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX idx_conversations_updated ON conversations (updated_at)",
    f"""
    CREATE TABLE messages (
        id              TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND {MAX_ID_LENGTH}),
        conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL CHECK (seq >= 1),
        role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content         TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND {MAX_CONTENT_CHARS}),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (conversation_id, seq)
    )
    """,
    f"""
    CREATE TABLE tasks (
        id              TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND {MAX_ID_LENGTH}),
        conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
        title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND {MAX_TITLE_CHARS}),
        description     TEXT NOT NULL DEFAULT '' CHECK (length(description) <= {MAX_DESCRIPTION_CHARS}),
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        completed_at    TEXT,
        CHECK ((status = 'completed') = (completed_at IS NOT NULL))
    )
    """,
    "CREATE INDEX idx_tasks_status ON tasks (status)",
    "CREATE INDEX idx_tasks_conversation ON tasks (conversation_id)",
)
# Schema version 2 (Step 6, automatic save progress). Purely additive: existing rows and columns are
# untouched. Tasks gain progress/phase/etc.; four new tables hold steps, requests, working context
# and app sessions (used to tell a crash from a clean exit). See progress.py.
_SCHEMA_V2 = (
    "ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100)",
    "ALTER TABLE tasks ADD COLUMN phase TEXT",
    "ALTER TABLE tasks ADD COLUMN instruction TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN activity TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN interrupted_at TEXT",
    f"""
    CREATE TABLE task_steps (
        task_id    TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        step_key   TEXT NOT NULL CHECK (length(step_key) BETWEEN 1 AND {MAX_ID_LENGTH}),
        seq        INTEGER NOT NULL CHECK (seq >= 0),
        label      TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND {MAX_TITLE_CHARS}),
        state      TEXT NOT NULL CHECK (state IN ('pending', 'active', 'done', 'skipped')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, step_key)
    )
    """,
    f"""
    CREATE TABLE task_requests (
        task_id       TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        req_key       TEXT NOT NULL CHECK (length(req_key) BETWEEN 1 AND {MAX_ID_LENGTH}),
        kind          TEXT NOT NULL CHECK (kind IN ('info', 'approval')),
        text          TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND {MAX_TITLE_CHARS}),
        detail        TEXT NOT NULL DEFAULT '',
        state         TEXT NOT NULL CHECK (state IN ('open', 'answered', 'skipped')),
        answer        TEXT,
        consequential INTEGER NOT NULL DEFAULT 0 CHECK (consequential IN (0, 1)),
        executed_at   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (task_id, req_key)
    )
    """,
    f"""
    CREATE TABLE work_context (
        id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND {MAX_ID_LENGTH}),
        task_id     TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('project', 'instruction', 'decision', 'file', 'activity', 'note')),
        content     TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND {MAX_DESCRIPTION_CHARS}),
        content_key TEXT NOT NULL,
        created_at  TEXT NOT NULL
    )
    """,
    # One record per (task, kind, content): saving the same thing twice can never duplicate it.
    "CREATE UNIQUE INDEX idx_work_context_unique ON work_context (COALESCE(task_id, ''), kind, content_key)",
    "CREATE INDEX idx_work_context_task ON work_context (task_id)",
    """
    CREATE TABLE app_sessions (
        id            TEXT PRIMARY KEY,
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        ended_cleanly INTEGER CHECK (ended_cleanly IN (0, 1))
    )
    """,
)
_MIGRATIONS: dict[int, tuple[str, ...]] = {1: _SCHEMA_V1, 2: _SCHEMA_V2}

_MISSING = object()


# ----------------------------------------------------------------------------- helpers
def utc_now_iso() -> str:
    """Timestamp stored in every record: ISO 8601, UTC, millisecond precision."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _bad(message: str) -> RequestError:
    return RequestError(INVALID_PAYLOAD, message)


def _check_id(value: Any, name: str = "id") -> str:
    if not isinstance(value, str) or not _ID_RE.match(value):
        raise _bad(f"'{name}' must be a string of 1-{MAX_ID_LENGTH} letters, digits, '_' or '-'.")
    return value


def _check_text(value: Any, name: str, *, max_chars: int, strip: bool = False, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise _bad(f"'{name}' must be a string.")
    if "\x00" in value:
        raise _bad(f"'{name}' must not contain NUL characters.")
    try:
        value.encode("utf-8")  # rejects lone surrogates, which SQLite cannot store
    except UnicodeEncodeError:
        raise _bad(f"'{name}' contains characters that cannot be stored.") from None
    if strip:
        value = value.strip()
    if not allow_empty and not value.strip():
        raise _bad(f"'{name}' must not be empty.")
    if len(value) > max_chars:
        raise _bad(f"'{name}' is longer than {max_chars} characters.")
    return value


def _check_choice(value: Any, name: str, choices: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in choices:
        raise _bad(f"'{name}' must be one of: {', '.join(choices)}.")
    return value


def _check_page(limit: Any, offset: Any) -> tuple[int, int]:
    def whole(v: Any, name: str, low: int, high: Optional[int]) -> int:
        if isinstance(v, bool) or not isinstance(v, int):
            raise _bad(f"'{name}' must be a whole number.")
        if v < low or (high is not None and v > high):
            raise _bad(f"'{name}' must be {low}" + (f" to {high}." if high is not None else " or more."))
        return v

    return (
        DEFAULT_LIMIT if limit is None else whole(limit, "limit", 1, MAX_LIMIT),
        0 if offset is None else whole(offset, "offset", 0, None),
    )


def _is_corruption(err: sqlite3.Error) -> bool:
    code = getattr(err, "sqlite_errorcode", None)  # Python 3.11+
    if isinstance(code, int) and (code & 0xFF) in (11, 26):  # SQLITE_CORRUPT, SQLITE_NOTADB
        return True
    text = str(err).lower()
    return "malformed" in text or "not a database" in text


def _row(row: Optional[sqlite3.Row]) -> Optional[dict]:
    return dict(row) if row is not None else None


# ----------------------------------------------------------------------------- database
class Database:
    """One SQLite file. Create it, call :meth:`open`, use it, call :meth:`close`.

    ``clock`` and ``id_factory`` exist so tests can control timestamps and ids.
    """

    def __init__(
        self,
        path: "str | Path",
        clock: Callable[[], str] = utc_now_iso,
        id_factory: Callable[[], str] = new_id,
    ):
        self.path = Path(path)
        self._clock = clock
        self._new_id = id_factory
        self._lock = threading.RLock()
        self._conn: Optional[sqlite3.Connection] = None
        self.recovered_from: Optional[str] = None  # file name of a damaged database moved aside

    # ------------------------------------------------------------------ open / close
    @property
    def is_open(self) -> bool:
        return self._conn is not None

    def open(self) -> "Database":
        with self._lock:
            if self._conn is not None:
                return self
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
            except OSError as err:
                log.error("cannot create the database folder: %s", err)
                raise RequestError(DB_UNAVAILABLE, "The local database folder could not be created.") from None
            try:
                self._conn = self._open_checked()
            except _Damaged as damaged:
                log.error("database file is damaged (%s); moving it aside", damaged)
                self.recovered_from = self._quarantine()
                try:
                    self._conn = self._open_checked()
                except _Damaged as again:
                    raise RequestError(DB_UNAVAILABLE, "The local database could not be created.") from again
            return self

    def close(self) -> None:
        with self._lock:
            conn, self._conn = self._conn, None
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error as err:  # nothing sensible left to do
                    log.warning("error while closing the database: %s", err)

    def __enter__(self) -> "Database":
        return self.open()

    def __exit__(self, *exc) -> None:
        self.close()

    def _open_checked(self) -> sqlite3.Connection:
        """Connect, verify, migrate. Raises _Damaged for a corrupt file, RequestError otherwise."""
        conn: Optional[sqlite3.Connection] = None
        try:
            # isolation_level=None: Python never opens transactions behind our back; we use
            # explicit BEGIN/COMMIT, which behaves identically on every supported Python.
            conn = sqlite3.connect(str(self.path), timeout=5.0, isolation_level=None, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout = 5000")
            conn.execute("PRAGMA foreign_keys = ON")
            if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
                raise RequestError(DB_UNAVAILABLE, "This SQLite build cannot enforce foreign keys.")
            verdict = conn.execute("PRAGMA quick_check").fetchone()
            if verdict is None or verdict[0] != "ok":
                raise _Damaged("integrity check failed")
            self._migrate(conn)
            return conn
        except _Damaged:
            self._quiet_close(conn)
            raise
        except RequestError:
            self._quiet_close(conn)
            raise
        except sqlite3.Error as err:
            self._quiet_close(conn)
            if _is_corruption(err):
                raise _Damaged(str(err)) from None
            log.error("cannot open the database: %s", err)
            raise RequestError(DB_UNAVAILABLE, "The local database could not be opened.") from None

    @staticmethod
    def _quiet_close(conn: Optional[sqlite3.Connection]) -> None:
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        if current > SCHEMA_VERSION:
            # Made by a newer FIDEX AI. Never touch it.
            raise RequestError(DB_UNAVAILABLE, "The local database was created by a newer version of FIDEX AI.")
        for version in range(current + 1, SCHEMA_VERSION + 1):
            conn.execute("BEGIN IMMEDIATE")
            try:
                for statement in _MIGRATIONS[version]:
                    conn.execute(statement)
                conn.execute(f"PRAGMA user_version = {int(version)}")  # int(): a number, not input
                conn.execute("COMMIT")
            except BaseException:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise

    def _quarantine(self) -> str:
        """Move the damaged file (and its journal files) aside. Returns the new file name."""
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        target = self.path.with_name(f"{self.path.name}.corrupt-{stamp}")
        n = 1
        while target.exists():
            n += 1
            target = self.path.with_name(f"{self.path.name}.corrupt-{stamp}-{n}")
        try:
            self.path.replace(target)
            for suffix in ("-journal", "-wal", "-shm"):
                side = Path(str(self.path) + suffix)
                if side.exists():
                    side.replace(Path(str(target) + suffix))
        except OSError as err:
            log.error("could not move the damaged database aside: %s", err)
            raise RequestError(DB_UNAVAILABLE, "The local database is damaged and could not be replaced.") from None
        return target.name

    # ------------------------------------------------------------------ transactions
    def _require(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RequestError(DB_UNAVAILABLE, "The local database is not open.")
        return self._conn

    def _translate(self, err: sqlite3.Error) -> RequestError:
        """Turn a SQLite exception into a safe, stable error. Details go to the log only."""
        log.error("database error: %s: %s", type(err).__name__, err)
        if isinstance(err, sqlite3.IntegrityError):
            text = str(err)
            if "UNIQUE" in text and (".id" in text or "PRIMARY" in text):
                return RequestError(DUPLICATE_ID, "A record with this id already exists.")
            return RequestError(INVALID_PAYLOAD, "The record was rejected by the database rules.")
        if _is_corruption(err):
            self._invalidate()
            return RequestError(DB_UNAVAILABLE, "The local database is damaged. Restart FIDEX AI to repair it.")
        if isinstance(err, sqlite3.OperationalError) and "locked" in str(err).lower():
            return RequestError(DB_ERROR, "The local database is busy. Try again.")
        return RequestError(DB_ERROR, "The local database could not complete the request.")

    def _invalidate(self) -> None:
        conn, self._conn = self._conn, None
        self._quiet_close(conn)

    @contextmanager
    def _tx(self):
        """Serial, atomic access: BEGIN IMMEDIATE ... COMMIT, or ROLLBACK if anything goes wrong."""
        with self._lock:
            conn = self._require()
            try:
                conn.execute("BEGIN IMMEDIATE")
            except sqlite3.Error as err:
                raise self._translate(err) from None
            try:
                yield conn
                conn.execute("COMMIT")
            except RequestError:
                self._rollback(conn)
                raise
            except sqlite3.Error as err:
                self._rollback(conn)
                raise self._translate(err) from None
            except BaseException:
                self._rollback(conn)
                raise

    @staticmethod
    def _rollback(conn: sqlite3.Connection) -> None:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass  # no transaction is open any more

    @contextmanager
    def _read(self):
        with self._lock:
            conn = self._require()
            try:
                yield conn
            except sqlite3.Error as err:
                raise self._translate(err) from None

    def _make_id(self, supplied: Any) -> str:
        return _check_id(supplied) if supplied is not None else self._new_id()

    # ------------------------------------------------------------------ status
    def status(self) -> dict:
        """Safe summary for the interface. Deliberately contains no file path."""
        with self._read() as conn:
            counts = {
                name: conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]  # fixed names, no input
                for name in ("conversations", "messages", "tasks")
            }
            return {
                "ready": True,
                "schema_version": conn.execute("PRAGMA user_version").fetchone()[0],
                "sqlite_version": sqlite3.sqlite_version,
                "counts": counts,
                "recovered_from_damage": self.recovered_from is not None,
            }

    # ------------------------------------------------------------------ conversations
    _CONVERSATION_SELECT = (
        "SELECT c.id, c.title, c.created_at, c.updated_at, "
        "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count "
        "FROM conversations c"
    )

    def create_conversation(self, title: Any = None, id: Any = None) -> dict:
        title = DEFAULT_CONVERSATION_TITLE if title is None else _check_text(title, "title", max_chars=MAX_TITLE_CHARS, strip=True)
        cid = self._make_id(id)
        now = self._clock()
        with self._tx() as conn:
            if conn.execute("SELECT 1 FROM conversations WHERE id = ?", (cid,)).fetchone():
                raise RequestError(DUPLICATE_ID, "A conversation with this id already exists.")
            conn.execute(
                "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
                (cid, title, now, now),
            )
            return _row(conn.execute(self._CONVERSATION_SELECT + " WHERE c.id = ?", (cid,)).fetchone())

    def get_conversation(self, id: Any) -> dict:
        cid = _check_id(id)
        with self._read() as conn:
            row = conn.execute(self._CONVERSATION_SELECT + " WHERE c.id = ?", (cid,)).fetchone()
        if row is None:
            raise RequestError(NOT_FOUND, "Conversation not found.")
        return dict(row)

    def list_conversations(self, limit: Any = None, offset: Any = None) -> dict:
        limit, offset = _check_page(limit, offset)
        with self._read() as conn:
            total = conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
            rows = conn.execute(
                self._CONVERSATION_SELECT + " ORDER BY c.updated_at DESC, c.created_at DESC, c.id LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return {"items": [dict(r) for r in rows], "total": total, "limit": limit, "offset": offset}

    def update_conversation(self, id: Any, title: Any) -> dict:
        cid = _check_id(id)
        title = _check_text(title, "title", max_chars=MAX_TITLE_CHARS, strip=True)
        with self._tx() as conn:
            cur = conn.execute("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", (title, self._clock(), cid))
            if cur.rowcount == 0:
                raise RequestError(NOT_FOUND, "Conversation not found.")
            return _row(conn.execute(self._CONVERSATION_SELECT + " WHERE c.id = ?", (cid,)).fetchone())

    def delete_conversation(self, id: Any) -> dict:
        """Deletes the conversation and its messages. Tasks that referred to it are kept (unlinked)."""
        cid = _check_id(id)
        with self._tx() as conn:
            n_messages = conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (cid,)).fetchone()[0]
            cur = conn.execute("DELETE FROM conversations WHERE id = ?", (cid,))
            if cur.rowcount == 0:
                raise RequestError(NOT_FOUND, "Conversation not found.")
        return {"deleted": True, "id": cid, "messages_deleted": n_messages}

    # ------------------------------------------------------------------ messages
    _MESSAGE_COLUMNS = "id, conversation_id, seq, role, content, created_at, updated_at"

    def create_message(self, conversation_id: Any, role: Any, content: Any, id: Any = None) -> dict:
        cid = _check_id(conversation_id, "conversation_id")
        role = _check_choice(role, "role", ROLES)
        content = _check_text(content, "content", max_chars=MAX_CONTENT_CHARS)
        mid = self._make_id(id)
        now = self._clock()
        with self._tx() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (cid,)).fetchone():
                raise RequestError(NOT_FOUND, "Conversation not found.")
            if conn.execute("SELECT 1 FROM messages WHERE id = ?", (mid,)).fetchone():
                raise RequestError(DUPLICATE_ID, "A message with this id already exists.")
            seq = conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?", (cid,)).fetchone()[0]
            conn.execute(
                "INSERT INTO messages (id, conversation_id, seq, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (mid, cid, seq, role, content, now, now),
            )
            conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, cid))
            return _row(conn.execute(f"SELECT {self._MESSAGE_COLUMNS} FROM messages WHERE id = ?", (mid,)).fetchone())

    def get_message(self, id: Any) -> dict:
        mid = _check_id(id)
        with self._read() as conn:
            row = conn.execute(f"SELECT {self._MESSAGE_COLUMNS} FROM messages WHERE id = ?", (mid,)).fetchone()
        if row is None:
            raise RequestError(NOT_FOUND, "Message not found.")
        return dict(row)

    def list_messages(self, conversation_id: Any, limit: Any = None, offset: Any = None) -> dict:
        """Oldest first (by ``seq``)."""
        cid = _check_id(conversation_id, "conversation_id")
        limit, offset = _check_page(limit, offset)
        with self._read() as conn:
            if not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (cid,)).fetchone():
                raise RequestError(NOT_FOUND, "Conversation not found.")
            total = conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id = ?", (cid,)).fetchone()[0]
            rows = conn.execute(
                f"SELECT {self._MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT ? OFFSET ?",
                (cid, limit, offset),
            ).fetchall()
        return {"items": [dict(r) for r in rows], "total": total, "limit": limit, "offset": offset}

    def update_message(self, id: Any, content: Any) -> dict:
        mid = _check_id(id)
        content = _check_text(content, "content", max_chars=MAX_CONTENT_CHARS)
        now = self._clock()
        with self._tx() as conn:
            row = conn.execute("SELECT conversation_id FROM messages WHERE id = ?", (mid,)).fetchone()
            if row is None:
                raise RequestError(NOT_FOUND, "Message not found.")
            conn.execute("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?", (content, now, mid))
            conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, row["conversation_id"]))
            return _row(conn.execute(f"SELECT {self._MESSAGE_COLUMNS} FROM messages WHERE id = ?", (mid,)).fetchone())

    def delete_message(self, id: Any) -> dict:
        mid = _check_id(id)
        with self._tx() as conn:
            row = conn.execute("SELECT conversation_id FROM messages WHERE id = ?", (mid,)).fetchone()
            if row is None:
                raise RequestError(NOT_FOUND, "Message not found.")
            conn.execute("DELETE FROM messages WHERE id = ?", (mid,))
            conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (self._clock(), row["conversation_id"]))
        return {"deleted": True, "id": mid}

    # ------------------------------------------------------------------ tasks
    _TASK_COLUMNS = "id, conversation_id, title, description, status, created_at, updated_at, completed_at"

    def create_task(
        self,
        title: Any,
        description: Any = None,
        status: Any = None,
        conversation_id: Any = None,
        id: Any = None,
    ) -> dict:
        title = _check_text(title, "title", max_chars=MAX_TITLE_CHARS, strip=True)
        description = "" if description is None else _check_text(description, "description", max_chars=MAX_DESCRIPTION_CHARS, allow_empty=True)
        status = "pending" if status is None else _check_choice(status, "status", TASK_STATUSES)
        cid = None if conversation_id is None else _check_id(conversation_id, "conversation_id")
        tid = self._make_id(id)
        now = self._clock()
        with self._tx() as conn:
            if cid is not None and not conn.execute("SELECT 1 FROM conversations WHERE id = ?", (cid,)).fetchone():
                raise RequestError(NOT_FOUND, "Conversation not found.")
            if conn.execute("SELECT 1 FROM tasks WHERE id = ?", (tid,)).fetchone():
                raise RequestError(DUPLICATE_ID, "A task with this id already exists.")
            conn.execute(
                "INSERT INTO tasks (id, conversation_id, title, description, status, created_at, updated_at, completed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (tid, cid, title, description, status, now, now, now if status == "completed" else None),
            )
            return _row(conn.execute(f"SELECT {self._TASK_COLUMNS} FROM tasks WHERE id = ?", (tid,)).fetchone())

    def get_task(self, id: Any) -> dict:
        tid = _check_id(id)
        with self._read() as conn:
            row = conn.execute(f"SELECT {self._TASK_COLUMNS} FROM tasks WHERE id = ?", (tid,)).fetchone()
        if row is None:
            raise RequestError(NOT_FOUND, "Task not found.")
        return dict(row)

    def list_tasks(self, status: Any = None, conversation_id: Any = None, limit: Any = None, offset: Any = None) -> dict:
        """Newest first. Optional filters: ``status`` and ``conversation_id``."""
        status = None if status is None else _check_choice(status, "status", TASK_STATUSES)
        cid = None if conversation_id is None else _check_id(conversation_id, "conversation_id")
        limit, offset = _check_page(limit, offset)
        # The WHERE text is assembled only from these two fixed fragments; values stay parameters.
        where, args = [], []
        if status is not None:
            where.append("status = ?")
            args.append(status)
        if cid is not None:
            where.append("conversation_id = ?")
            args.append(cid)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        with self._read() as conn:
            total = conn.execute("SELECT COUNT(*) FROM tasks" + clause, args).fetchone()[0]
            rows = conn.execute(
                f"SELECT {self._TASK_COLUMNS} FROM tasks" + clause + " ORDER BY created_at DESC, id LIMIT ? OFFSET ?",
                [*args, limit, offset],
            ).fetchall()
        return {"items": [dict(r) for r in rows], "total": total, "limit": limit, "offset": offset}

    def update_task(self, id: Any, fields: dict) -> dict:
        """``fields`` may contain title, description, status. Only the given fields change."""
        tid = _check_id(id)
        if not isinstance(fields, dict) or not fields:
            raise _bad("Nothing to update: give at least one of title, description, status.")
        unknown = sorted(set(fields) - {"title", "description", "status"})
        if unknown:
            raise _bad(f"Unknown field '{unknown[0]}'.")
        title = _check_text(fields["title"], "title", max_chars=MAX_TITLE_CHARS, strip=True) if "title" in fields else _MISSING
        description = (
            _check_text(fields["description"], "description", max_chars=MAX_DESCRIPTION_CHARS, allow_empty=True)
            if "description" in fields
            else _MISSING
        )
        status = _check_choice(fields["status"], "status", TASK_STATUSES) if "status" in fields else _MISSING
        now = self._clock()
        with self._tx() as conn:
            row = conn.execute(f"SELECT {self._TASK_COLUMNS} FROM tasks WHERE id = ?", (tid,)).fetchone()
            if row is None:
                raise RequestError(NOT_FOUND, "Task not found.")
            new_title = row["title"] if title is _MISSING else title
            new_description = row["description"] if description is _MISSING else description
            new_status = row["status"] if status is _MISSING else status
            if new_status == "completed":
                completed_at = row["completed_at"] or now
            else:
                completed_at = None
            conn.execute(
                "UPDATE tasks SET title = ?, description = ?, status = ?, completed_at = ?, updated_at = ? WHERE id = ?",
                (new_title, new_description, new_status, completed_at, now, tid),
            )
            return _row(conn.execute(f"SELECT {self._TASK_COLUMNS} FROM tasks WHERE id = ?", (tid,)).fetchone())

    def delete_task(self, id: Any) -> dict:
        tid = _check_id(id)
        with self._tx() as conn:
            if conn.execute("DELETE FROM tasks WHERE id = ?", (tid,)).rowcount == 0:
                raise RequestError(NOT_FOUND, "Task not found.")
        return {"deleted": True, "id": tid}


class _Damaged(Exception):
    """Internal: the database file is not a usable SQLite database."""
