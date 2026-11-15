"""Permanent local memory for FIDEX AI (SQLite, standard library only).

Facts about the user are stored once, on this computer. For every question only the few memories that
match it (plus the user's name) are put into the prompt - never the whole profile or database.

Database file: FIDEX_DB_PATH (set it to the app's existing SQLite file to share it; the `memories` and
`memory_meta` tables are added next to the existing tables). Default: ~/.fidex/fidex.db
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time

from .protocol import DB_ERROR, INVALID_PAYLOAD, NOT_FOUND, RequestError

CATEGORIES = ("identity", "profile", "project", "preference", "instruction", "fact")
MAX_CONTENT = 400
MAX_ROWS = 2000
MAX_RECALL = 5  # relevant memories added to one prompt
RECALL_CHARS = 700  # character budget for them
FULL_MAX_RECALL = 10  # Take Over / Guide Me: more of the permanent memory is allowed
FULL_RECALL_CHARS = 1500
MODES = ("chat", "takeover", "guide")  # "chat" = Normal Chat (name + main project only)
IDENTITY_KEYS = {"name", "full name", "preferred name", "nickname", "call me"}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'user',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  UNIQUE(category, key)
);
CREATE TABLE IF NOT EXISTS memory_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""
_ready: set[str] = set()
_STOP = set("the and for you your with that this have has what who how are was were can could would should about from into just like tell give make get does did not but all any out our its his her they them then than too very".split())


def db_path() -> str:
    return os.environ.get("FIDEX_DB_PATH") or os.path.join(os.path.expanduser("~"), ".fidex", "fidex.db")


def _conn() -> sqlite3.Connection:
    path = db_path()
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        con = sqlite3.connect(path, timeout=5)
        con.row_factory = sqlite3.Row
        if path not in _ready:
            con.executescript(_SCHEMA)
            con.commit()
            _ready.add(path)
        return con
    except (sqlite3.Error, OSError) as err:
        raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None


def _tokens(text: str) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z0-9][a-z0-9'-]{2,}", (text or "").lower()):
        if w in _STOP:
            continue
        out.add(w[:-1] if len(w) > 4 and w.endswith("s") else w)
    return out


def _slug(text: str, words: int = 4) -> str:
    return "-".join(re.findall(r"[a-z0-9]+", text.lower())[:words])[:48] or "note"


def _row(r: sqlite3.Row) -> dict:
    return {k: r[k] for k in ("id", "category", "key", "content", "source", "created_at", "updated_at")}


def _clean(content, limit=MAX_CONTENT) -> str:
    if not isinstance(content, str) or not content.strip():
        raise RequestError(INVALID_PAYLOAD, "Memory text must be a non-empty string.")
    return " ".join(content.split())[:limit]


def _check_category(category) -> str:
    if category not in CATEGORIES:
        raise RequestError(INVALID_PAYLOAD, f"'category' must be one of: {', '.join(CATEGORIES)}.")
    return category


def upsert(category: str, key: str, content: str, source: str = "user", con: sqlite3.Connection | None = None) -> dict:
    category, content, key = _check_category(category), _clean(content), (key or _slug(content))[:60]
    own = con is None
    con = con or _conn()
    try:
        now = time.time()
        kw = " ".join(sorted(_tokens(key + " " + content)))
        row = con.execute("SELECT id FROM memories WHERE category=? AND key=?", (category, key)).fetchone()
        if row:
            con.execute("UPDATE memories SET content=?, keywords=?, source=?, updated_at=? WHERE id=?", (content, kw, source, now, row["id"]))
            rid = row["id"]
        else:
            if con.execute("SELECT COUNT(*) FROM memories").fetchone()[0] >= MAX_ROWS:
                raise RequestError(INVALID_PAYLOAD, "Memory is full. Delete some memories first.")
            rid = con.execute(
                "INSERT INTO memories(category,key,content,keywords,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (category, key, content, kw, source, now, now),
            ).lastrowid
        if own:
            con.commit()
        return _row(con.execute("SELECT * FROM memories WHERE id=?", (rid,)).fetchone())
    except sqlite3.Error as err:
        raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None
    finally:
        if own:
            con.close()


def update(memory_id, content=None, category=None) -> dict:
    con = _conn()
    try:
        row = con.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
        if not row:
            raise RequestError(NOT_FOUND, "That memory does not exist.")
        new_content = _clean(content) if content is not None else row["content"]
        new_cat = _check_category(category) if category is not None else row["category"]
        kw = " ".join(sorted(_tokens(row["key"] + " " + new_content)))
        try:
            # an edited memory becomes the user's own, so a later profile sync never overwrites it
            con.execute("UPDATE memories SET content=?, category=?, keywords=?, source='user', updated_at=? WHERE id=?", (new_content, new_cat, kw, time.time(), memory_id))
            con.commit()
        except sqlite3.IntegrityError:
            raise RequestError(INVALID_PAYLOAD, "A memory with that category and name already exists.") from None
        return _row(con.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone())
    except sqlite3.Error as err:
        raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None
    finally:
        con.close()


def delete(memory_id) -> dict:
    con = _conn()
    try:
        n = con.execute("DELETE FROM memories WHERE id=?", (memory_id,)).rowcount
        con.commit()
    except sqlite3.Error as err:
        raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None
    finally:
        con.close()
    if not n:
        raise RequestError(NOT_FOUND, "That memory does not exist.")
    return {"deleted": memory_id}


def list_all(category: str | None = None, query: str = "", limit: int = 500) -> list[dict]:
    con = _conn()
    try:
        rows = [_row(r) for r in con.execute("SELECT * FROM memories" + (" WHERE category=?" if category else "") + " ORDER BY category, updated_at DESC", (category,) if category else ())]
    except sqlite3.Error as err:
        raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None
    finally:
        con.close()
    q = (query or "").strip().lower()
    if q:
        rows = [r for r in rows if q in r["content"].lower() or q in r["key"].lower()]
    return rows[:limit]


def _main_project(rows) -> str:
    """The user's main project: the most recently saved project memory (or a profile line about a project)."""
    best = None
    for r in rows:
        if r["category"] == "project" or (r["category"] == "profile" and "project" in r["key"]):
            if best is None or (r["updated_at"] or 0) > (best["updated_at"] or 0):
                best = r
    return best["content"][:160] if best else ""


def relevant(question: str, mode: str = "chat") -> str:
    """Text added to the prompt.
    mode "chat" (Normal Chat): only the user's name and main project.
    mode "takeover" / "guide": name plus the best-matching permanent memories (full memory, filtered by relevance)."""
    if mode not in MODES:
        raise RequestError(INVALID_PAYLOAD, f"'mode' must be one of: {', '.join(MODES)}.")
    con = _conn()
    try:
        rows = con.execute("SELECT category, key, content, keywords, updated_at FROM memories").fetchall()
    except sqlite3.Error:
        return ""
    finally:
        con.close()
    if not rows:
        return ""
    lines, used = [], 0
    for r in rows:  # identity is tiny and always useful
        if r["category"] == "identity":
            lines.append(r["content"][:120])
            used += len(lines[-1])
    project = _main_project(rows)
    if mode == "chat":
        if project and re.search(r"\b(projects?|working on|my work|my goals?)\b", question or "", re.I):  # only when the user asks
            lines.append("Main project: " + project)
        return "\n".join(lines)
    max_recall, budget = FULL_MAX_RECALL, FULL_RECALL_CHARS
    q = _tokens(question)
    scored = []
    for r in rows:
        if r["category"] == "identity":
            continue
        score = len(q & set(r["keywords"].split()))
        if r["category"] == "instruction":
            score += 1  # standing instructions ("always answer short") apply to everything
        if score > (1 if r["category"] == "instruction" else 0):
            scored.append((score, r))
    scored.sort(key=lambda t: -t[0])
    for _, r in scored[:max_recall]:
        if used + len(r["content"]) > budget:
            break
        lines.append(r["content"])
        used += len(r["content"])
    if project and project not in lines:
        lines.append("Main project: " + project)
    return "\n".join(lines)


def sync_profile(profile_text: str) -> dict:
    """Mirror the 'Give Me Your Details' profile into memory. Skipped instantly if nothing changed."""
    text = (profile_text or "").strip()
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    con = _conn()
    try:
        old = con.execute("SELECT v FROM memory_meta WHERE k='profile_hash'").fetchone()
        if old and old["v"] == digest:
            return {"changed": False}
        seen = set()
        for line in text.splitlines():
            line = line.strip(" -*\t")
            if not line:
                continue
            label, sep, value = line.partition(":")
            if sep and value.strip():
                key = label.strip().lower()[:60]
                cat = "identity" if key in IDENTITY_KEYS else "profile"
                content = f"{label.strip()}: {value.strip()}"
            else:
                key, cat, content = _slug(line), "profile", line
            exists = con.execute("SELECT source FROM memories WHERE category=? AND key=?", (cat, key)).fetchone()
            seen.add((cat, key))
            if exists and exists["source"] == "user":
                continue  # user edited it in the memory panel: keep their version
            upsert(cat, key, content, "profile", con)
        for r in con.execute("SELECT id, category, key FROM memories WHERE source='profile'").fetchall():
            if (r["category"], r["key"]) not in seen:
                con.execute("DELETE FROM memories WHERE id=?", (r["id"],))
        con.execute("INSERT OR REPLACE INTO memory_meta(k,v) VALUES('profile_hash',?)", (digest,))
        con.commit()
        return {"changed": True}
    except sqlite3.Error as err:
        raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None
    finally:
        con.close()


def forget(scope: str = "chat") -> dict:
    """Really remove stored memory: scope 'chat' (facts learned from chat messages), 'profile' (copies of the saved details) or 'all'."""
    if scope == "everything":  # start from the beginning: every memory, the profile mirror and what the Brain learned
        con = _conn()
        try:
            n = con.execute("DELETE FROM memories").rowcount
            con.execute("DELETE FROM memory_meta")
            con.commit()
        except sqlite3.Error as err:
            raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None
        finally:
            con.close()
        try:
            from . import brain
            bc = brain._conn()
            for t in ("knowledge", "activity"):
                bc.execute(f"DELETE FROM {t}")
            bc.commit()
            bc.close()
        except Exception:  # noqa: BLE001 - the Brain tables are optional
            pass
        return {"removed": n, "scope": scope}
    sources = {"chat": ("chat",), "profile": ("profile",), "all": ("chat", "profile")}.get(scope)
    if not sources:
        raise RequestError(INVALID_PAYLOAD, "scope must be chat, profile or all.")
    con = _conn()
    try:
        n = 0
        for s in sources:
            n += con.execute("DELETE FROM memories WHERE source=?", (s,)).rowcount
        if "profile" in sources:
            con.execute("DELETE FROM memory_meta WHERE k='profile_hash'")  # so the next profile save is mirrored again
        con.commit()
        return {"removed": n, "scope": scope}
    except sqlite3.Error as err:
        raise RequestError(DB_ERROR, f"Memory database problem: {err}") from None
    finally:
        con.close()


_NAME = r"[A-Za-z][A-Za-z'-]+(?:(?-i: [A-Z][A-Za-z'-]+)){0,2}"
_BAD_NAMES = {"is", "not", "a", "the", "going", "trying", "so", "very"}
_G = lambda m, i=1: m.group(i).strip()  # noqa: E731
_RULES = [  # (regex, category, key(m), content(m))
    (re.compile(r"\bmy name is (" + _NAME + r")", re.I), "identity", lambda m: "name", lambda m: f"Name: {_G(m)}"),
    (re.compile(r"\bcall me (" + _NAME + r")", re.I), "identity", lambda m: "preferred name", lambda m: f"Preferred name: {_G(m)}"),
    (re.compile(r"\bi (?:live|am living|am based) in ([^.,;!?]{2,40})", re.I), "profile", lambda m: "location", lambda m: f"Lives in {_G(m)}"),
    (re.compile(r"\bi work (as|at|for) ([^.,;!?]{2,50})", re.I), "profile", lambda m: "work", lambda m: f"Works {_G(m)} {_G(m, 2)}"),
    (re.compile(r"\bi(?:'m| am) (?:building|working on|developing|creating) ([^.,;!?]{3,60})", re.I), "project", lambda m: _slug(_G(m)), lambda m: f"Working on {_G(m)}"),
    (re.compile(r"\bi (love|like|prefer|enjoy|hate|dislike) ([^.,;!?]{3,50})", re.I), "preference", lambda m: _G(m).lower() + "-" + _slug(_G(m, 2)), lambda m: f"User {_G(m).lower()}s {_G(m, 2)}"),
    (re.compile(r"\b(?:from now on|always|never)\b[^.!?]{4,120}", re.I), "instruction", lambda m: _slug(m.group(0), 6), lambda m: m.group(0).strip()),
    (re.compile(r"\bremember (?:that )?([^.!?]{4,200})", re.I), "fact", lambda m: _slug(_G(m), 6), lambda m: _G(m)),
]


def learn(user_text: str) -> list[dict]:
    """Save durable facts the user states about themselves. Questions and small talk are ignored."""
    text = (user_text or "").strip()
    if not text or text.endswith("?") or len(text) > 500:
        return []
    saved = []
    con = _conn()
    try:
        for rx, cat, keyfn, contentfn in _RULES:
            m = rx.search(text)
            if not m or (cat == "identity" and _G(m).lower() in _BAD_NAMES):
                continue
            saved.append(upsert(cat, keyfn(m), contentfn(m), "chat", con))
            if len(saved) >= 3:
                break
        con.commit()
    except (RequestError, sqlite3.Error):
        pass  # memory full etc.: never break the chat because of it
    finally:
        con.close()
    return saved


def stats() -> dict:
    con = _conn()
    try:
        total = con.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        per = {r["category"]: r["n"] for r in con.execute("SELECT category, COUNT(*) AS n FROM memories GROUP BY category")}
    finally:
        con.close()
    return {"total": total, "by_category": per, "db_path": db_path()}
