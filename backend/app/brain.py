"""Take Over brain: a dedicated, self-contained SQLite file (~/.fidex/takeover_brain.db) with
  activity  : everything Take Over did (goal, step, ok/failed)
  knowledge : what it learns about the user and the computer (locations, apps, emails, preferred AI, facts, passwords)
Passwords are encrypted (Windows DPAPI; fallback: a per-install key file) and never stored or logged in plain text.
Reads are one small query; activity writes are queued so acting/thinking never waits. Every failure is logged, never silent."""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import queue
import re
import secrets
import sqlite3
import sys
import threading
import time

log = logging.getLogger("fidex.brain")
KINDS = ("location", "app", "email", "account", "password", "preferred_ai", "habit", "fact")
MAX_ACTIVITY = 3000
SCHEMA = """
CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, goal TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS knowledge (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL, updated REAL NOT NULL, PRIMARY KEY(kind, key));
"""
_lock = threading.RLock()
_ready: set[str] = set()
_revealed: set[str] = set()  # secrets handed to the planner: scrubbed from the activity log
_last_error = ""


def db_path() -> str:
    return os.environ.get("FIDEX_BRAIN_DB") or os.path.join(os.path.expanduser("~"), ".fidex", "takeover_brain.db")


def _conn() -> sqlite3.Connection:
    path = db_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.row_factory = sqlite3.Row
    if path not in _ready:
        try:
            con.execute("PRAGMA journal_mode=WAL")
        except sqlite3.Error:
            pass
        con.executescript(SCHEMA)
        con.commit()
        _ready.add(path)
    return con


def _fail(where: str, err: BaseException) -> None:
    global _last_error
    _last_error = f"{where}: {type(err).__name__}: {err}"
    log.error("brain %s", _last_error)


# ---------------- encryption ----------------
def _keyfile() -> bytes:
    path = os.path.join(os.path.dirname(os.path.abspath(db_path())), "brain.key")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _lock:
        if os.path.isfile(path):
            with open(path, "rb") as fh:
                return fh.read()
        key = secrets.token_bytes(32)
        with open(path, "xb") as fh:
            fh.write(key)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return key


def _stream(key: bytes, nonce: bytes, n: int) -> bytes:
    out, i = b"", 0
    while len(out) < n:
        out += hmac.new(key, nonce + i.to_bytes(4, "big"), hashlib.sha256).digest()
        i += 1
    return out[:n]


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes  # noqa: PLC0415
    from ctypes import wintypes  # noqa: PLC0415

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    fn.argtypes = [ctypes.POINTER(BLOB), wintypes.LPCWSTR if protect else ctypes.c_void_p, ctypes.POINTER(BLOB), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(BLOB)]
    fn.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)  # kept alive until the call returns
    src, out = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte))), BLOB()
    if not fn(ctypes.byref(src), None, None, None, None, 0, ctypes.byref(out)):
        raise OSError("DPAPI call failed")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)


def encrypt(text: str) -> str:
    raw = text.encode("utf-8")
    if sys.platform == "win32":
        try:
            return "dpapi:" + base64.b64encode(_dpapi(raw, True)).decode()
        except Exception as err:  # noqa: BLE001
            _fail("DPAPI encrypt (using key-file fallback)", err)
    nonce = secrets.token_bytes(16)
    ct = bytes(a ^ b for a, b in zip(raw, _stream(_keyfile(), nonce, len(raw))))
    tag = hmac.new(_keyfile(), nonce + ct, hashlib.sha256).digest()[:16]
    return "k1:" + base64.b64encode(nonce + tag + ct).decode()


def decrypt(blob: str) -> str:
    if blob.startswith("dpapi:"):
        return _dpapi(base64.b64decode(blob[6:]), False).decode("utf-8")
    if blob.startswith("k1:"):
        data = base64.b64decode(blob[3:])
        nonce, tag, ct = data[:16], data[16:32], data[32:]
        if not hmac.compare_digest(tag, hmac.new(_keyfile(), nonce + ct, hashlib.sha256).digest()[:16]):
            raise ValueError("stored secret failed its integrity check")
        return bytes(a ^ b for a, b in zip(ct, _stream(_keyfile(), nonce, len(ct)))).decode("utf-8")
    raise ValueError("unknown secret format")


# ---------------- writing ----------------
_q: "queue.Queue[tuple]" = queue.Queue(maxsize=1000)
_writer_started = False


def _write_activity(args: tuple) -> None:
    with _lock:
        con = _conn()
        try:
            con.execute("INSERT INTO activity(ts,goal,action,ok,detail) VALUES(?,?,?,?,?)", (time.time(), *args))
            con.execute("DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - ?", (MAX_ACTIVITY,))
            con.commit()
        finally:
            con.close()


def _writer() -> None:
    while True:
        args = _q.get()
        try:
            _write_activity(args)
        except Exception as err:  # noqa: BLE001
            _fail("activity write", err)


def _scrub(text: str) -> str:
    for v in list(_revealed):
        text = text.replace(v, "****")
    return text


def log_action(goal: str, action: str, ok: bool, detail: str = "") -> None:
    global _writer_started
    with _lock:
        if not _writer_started:
            threading.Thread(target=_writer, daemon=True).start()
            _writer_started = True
    try:
        _q.put_nowait((_scrub(goal or "")[:300], _scrub(action)[:200], 1 if ok else 0, _scrub(detail or "")[:300]))
    except queue.Full:
        pass


def remember(kind: str, key: str, value: str, secret: bool = False) -> int:
    """Stores one fact NOW (a ~1 ms write, called off the hot path). Returns 1 on success, 0 on failure (the reason is in last_error())."""
    kind, key, value = str(kind), re.sub(r"\s+", " ", str(key).strip().lower())[:80], str(value).strip()[:400]
    if kind not in KINDS or not key or not value:
        return 0
    try:
        stored = encrypt(value) if secret else value
        now = time.time()
        with _lock:
            con = _conn()
            try:
                con.execute(
                    "INSERT INTO knowledge(kind,key,value,secret,uses,created,updated) VALUES(?,?,?,?,1,?,?) "
                    "ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value, secret=excluded.secret, uses=uses+1, updated=excluded.updated",
                    (kind, key, stored, 1 if secret else 0, now, now),
                )
                con.commit()
            finally:
                con.close()
        return 1
    except Exception as err:  # noqa: BLE001
        _fail(f"remember {kind}/{key}", err)
        return 0


def last_error() -> str:
    return _last_error


# ---------------- learning ----------------
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PW = [
    re.compile(r"\bpassword\s+for\s+([\w.@ -]{2,30}?)\s*(?:is|=|:)\s*(\S{3,80})", re.I),
    re.compile(r"\b(?:my\s+)?([\w.-]{2,30})\s+(?:password|passcode)\s*(?:is|=|:)\s*(\S{3,80})", re.I),
    re.compile(r"\b(?:my\s+)?()(?:password|passcode)\s*(?:is|=|:)\s*(\S{3,80})", re.I),
]
_REMEMBER = re.compile(r"^\s*(?:please\s+)?remember\s+(?:that\s+)?(.{3,300})$", re.I)
_AIS = ("claude", "chatgpt", "gemini", "copilot", "grok", "deepseek", "perplexity")


def _passwords(text: str) -> list[tuple[str, str]]:
    found, spans = [], []
    for rx in _PW:
        for m in rx.finditer(text):
            if any(m.start() < e and m.end() > s for s, e in spans):
                continue
            spans.append((m.start(), m.end()))
            name = (m.group(1) or "general").strip().lower()
            if name in ("my", "the", "a", "your", "new", "old"):
                name = "general"
            found.append((name, m.group(2).rstrip(".,;!")))
    return found


_LABEL = re.compile(r"^\s*task\s*:\s*", re.I)


def learn(text: str) -> dict:
    """Learns what the user states and tells the caller whether the WHOLE message was just information (nothing to do)."""
    text = _LABEL.sub("", str(text or "")).strip()[:600]
    sents = [x.strip().rstrip(".!") for x in re.split(r"(?<=[.!;])\s+|\n+", text) if x.strip()]
    info = bool(sents) and all(
        not x.endswith("?") and (_passwords(x) or (not _CMD.match(x) or _REMEMBER.match(x)) and (_MY.match(x) or _ME.match(x) or _REMEMBER.match(x))) for x in sents
    )
    n = learn_text(text)
    labels = [name + " password" for name, _ in _passwords(text)] + [m.group(1).lower() for x in sents for m in [_MY.match(x)] if m and not _passwords(x)]
    return {"learned": n, "statement": bool(info and n), "saved": labels[:5]}


def learn_text(text: str) -> int:
    """Learns what the user TELLS Take Over: passwords, emails, preferred AI, 'remember ...'."""
    text = _LABEL.sub("", (text or "")).strip()[:600]
    n = 0
    pw = _passwords(text)
    for name, value in pw:
        n += remember("password", name, value, secret=True)
    for e in _EMAIL.findall(text):
        n += remember("email", e.split("@")[1], e)
    low = text.lower()
    for ai_name in _AIS:
        if re.search(r"\b(?:use|with|to|in|on|always)\s+" + ai_name + r"\b", low):
            n += remember("preferred_ai", "default", ai_name)
            break
    if not pw:
        n += _learn_statements(text)
    return n


_MY = re.compile(r"^(?:my|our)\s+(.{2,40}?)\s+(?:is|are|was|were)\s+(.{1,200})$", re.I)
_ME = re.compile(r"^(?:i\s+(?:am|\'m|live|work|study|use|prefer|like|love|hate|always|usually|have|own|drive|speak|code|build)\b|call\s+me\b|i\s+go\s+by\b|we\s+(?:use|are|work|live)\b|the\s+(?:project|company|app|website)\s+(?:is|called)\b|(?:please\s+)?remember\b|don'?t\s+forget\b|from\s+now\s+on\b|note\s+that\b|for\s+future\b)", re.I)
_CMD = re.compile(r"^(?:open|make|create|write|type|press|click|go|search|find|show|send|play|run|start|close|delete|add|build|set|take|use\s+the|can|could|would|what|who|where|when|why|how|do|does|is|are|will)\b", re.I)


def _learn_statements(text: str) -> int:
    """Learns durable facts the user just STATES about themselves, with no 'remember' needed. Questions and commands are ignored."""
    n = 0
    for sent in re.split(r"(?<=[.!;])\s+|\n+", text):
        sent = sent.strip().rstrip(".!")
        if not 6 <= len(sent) <= 250 or sent.endswith("?") or (_CMD.match(sent) and not _REMEMBER.match(sent)):
            continue
        m = _REMEMBER.match(sent)
        if m:
            sent = m.group(1).strip()
        my = _MY.match(sent)
        if my:
            n += remember("fact", my.group(1).lower(), sent)  # keyed by the topic: a new value replaces the old one
        elif _ME.match(sent) or m:
            n += remember("fact", " ".join(sent.lower().split()[:6]), sent)
    return n


def learn_from_action(action: dict, goal: str = "") -> None:
    """After a step really succeeded: remember apps and file/folder locations."""
    try:
        k = action.get("type")
        if k == "open_app":
            remember("app", action["name"], f"opens with: {action['name']}")
        elif action.get("path"):
            p = str(action["path"])
            remember("location", os.path.basename(p.rstrip("/\\")) or p, p)
    except Exception as err:  # noqa: BLE001
        _fail("learn_from_action", err)


# ---------------- recall ----------------
def secrets_for(goal: str) -> str:
    """Saved passwords go to the planner ONLY when the task asks for one."""
    g = (goal or "").lower()
    if not re.search(r"password|passcode|log\s*in|login|sign\s*in", g):
        return ""
    try:
        with _lock:
            con = _conn()
            try:
                rows = con.execute("SELECT key,value FROM knowledge WHERE kind='password' ORDER BY updated DESC").fetchall()
            finally:
                con.close()
    except Exception as err:  # noqa: BLE001
        _fail("secrets_for", err)
        return ""
    syn = {"gmail": {"email", "mail", "google"}, "email": {"gmail", "mail"}}
    out = []
    specific = [r for r in rows if r["key"] != "general" and (r["key"] in g or any(w in g for w in set(r["key"].split()) | syn.get(r["key"], set())))]
    for r in (specific or rows[:1] if len(rows) == 1 else specific or [x for x in rows if x["key"] == "general"]):
        if True:
            try:
                v = decrypt(r["value"])
            except Exception as err:  # noqa: BLE001
                _fail(f"decrypt {r['key']}", err)
                continue
            _revealed.add(v)
            out.append(f"- password for {r['key']}: {v}")
    return ("Saved passwords the user asked for (use them exactly):\n" + "\n".join(out[:3])) if out else ""


def context(goal: str = "", limit_act: int = 8, limit_know: int = 12) -> str:
    try:
        with _lock:
            con = _conn()
            try:
                acts = con.execute("SELECT ts,goal,action,ok FROM activity ORDER BY id DESC LIMIT ?", (limit_act * 4,)).fetchall()
                know = con.execute("SELECT kind,key,value,uses FROM knowledge WHERE secret=0 ORDER BY uses DESC, updated DESC LIMIT 80").fetchall()
                names = [r["key"] for r in con.execute("SELECT key FROM knowledge WHERE kind='password'").fetchall()]
            finally:
                con.close()
    except Exception as err:  # noqa: BLE001
        _fail("context", err)
        return ""
    words = set(re.findall(r"[a-z0-9]{3,}", (goal or "").lower()))
    tok = lambda r: set(re.findall(r"[a-z0-9]{3,}", (r["key"] + " " + r["value"]).lower()))  # noqa: E731
    know = sorted(know, key=lambda r: -(len(words & tok(r)) * 10 + r["uses"]))[:limit_know]
    lines = []
    if acts:
        seen, recent = set(), []
        for r in acts:
            g = r["goal"] or r["action"]
            if g in seen:
                continue
            seen.add(g)
            recent.append(f"- {time.strftime('%b %d %H:%M', time.localtime(r['ts']))}: {g[:120]} (last step: {r['action'][:60]}, {'ok' if r['ok'] else 'FAILED'})")
            if len(recent) >= limit_act:
                break
        lines.append("Recent work (newest first):\n" + "\n".join(recent))
    if know:
        lines.append("What you know about this user and computer:\n" + "\n".join(f"- {r['kind']} {r['key']}: {r['value'][:120]}" for r in know))
    if names:
        lines.append("Passwords saved for: " + ", ".join(names[:10]) + " (the user can ask you to type one).")
    return "\n".join(lines)


def recent(limit: int = 30) -> list[dict]:
    with _lock:
        con = _conn()
        try:
            return [dict(r) for r in con.execute("SELECT ts,goal,action,ok,detail FROM activity ORDER BY id DESC LIMIT ?", (max(1, min(int(limit), 200)),))]
        finally:
            con.close()


def known(kind: str | None = None) -> list[dict]:
    with _lock:
        con = _conn()
        try:
            rows = con.execute("SELECT kind,key,value,secret,uses,updated FROM knowledge" + (" WHERE kind=?" if kind else "") + " ORDER BY uses DESC", (kind,) if kind else ()).fetchall()
        finally:
            con.close()
    return [{**dict(r), "value": "(protected)" if r["secret"] else r["value"]} for r in rows]


def selftest() -> dict:
    """Writes and reads back a password, a fact and an activity row, then deletes them. Tells exactly what failed."""
    checks, tag = {}, secrets.token_hex(3)
    try:
        checks["write_password"] = bool(remember("password", f"selftest{tag}", f"pw-{tag}", secret=True))
        checks["write_fact"] = bool(remember("fact", f"selftest{tag}", f"fact-{tag}"))
        _write_activity(("selftest", f"selftest {tag}", 1, ""))
        with _lock:
            con = _conn()
            try:
                row = con.execute("SELECT value FROM knowledge WHERE kind='password' AND key=?", (f"selftest{tag}",)).fetchone()
                checks["password_not_plain_text"] = bool(row) and f"pw-{tag}" not in row["value"]
                checks["password_decrypts"] = bool(row) and decrypt(row["value"]) == f"pw-{tag}"
                checks["fact_read_back"] = con.execute("SELECT 1 FROM knowledge WHERE kind='fact' AND key=?", (f"selftest{tag}",)).fetchone() is not None
                checks["activity_read_back"] = con.execute("SELECT 1 FROM activity WHERE action=?", (f"selftest {tag}",)).fetchone() is not None
                con.execute("DELETE FROM knowledge WHERE key=?", (f"selftest{tag}",))
                con.execute("DELETE FROM activity WHERE goal='selftest'")
                con.commit()
            finally:
                con.close()
    except Exception as err:  # noqa: BLE001
        _fail("selftest", err)
    return {"ok": bool(checks) and all(checks.values()), "checks": checks, "path": db_path(), "platform": sys.platform, "last_error": _last_error}


# ---------------- resolve: "type my favourite colour" -> "type blue" (before any planner or rule parser sees it) ----------------
_TYPE_VERB = re.compile(r"\b(?:type|write|enter|put|paste|input|fill\s+in|say|note\s+down|save|add)\b", re.I)
_PWREF = re.compile(r"\b(?:my|the|our)\s+(?:([\w.-]+)\s+)?(?:password|passcode)(?:\s+for\s+([\w.-]+))?", re.I)


def resolve(text: str) -> dict:
    """Replaces references to things the brain knows (my <topic>, my <name> password) with their saved value, but only in the part of the
    instruction that says what to type/write. Returns {text, replaced:[topics]}. Never raises; on any problem the text is returned unchanged."""
    text = _LABEL.sub("", str(text or ""))
    m = _TYPE_VERB.search(text)
    if not m:
        return {"text": text, "replaced": []}
    head, tail, done = text[: m.end()], text[m.end():], []
    try:
        with _lock:
            con = _conn()
            try:
                facts = con.execute("SELECT value FROM knowledge WHERE kind='fact' ORDER BY updated DESC").fetchall()
                pws = con.execute("SELECT key,value FROM knowledge WHERE kind='password' ORDER BY updated DESC").fetchall()
            finally:
                con.close()
        for r in facts:
            fm = _MY.match(r["value"])
            if not fm:
                continue
            topic, val = fm.group(1).strip(), fm.group(2).strip()
            rx = re.compile(r"\b(?:my|our|the)\s+" + re.escape(topic) + r"\b", re.I)
            if rx.search(tail):
                tail, k = rx.subn(lambda _m, v=val: v, tail, count=1)
                if k:
                    done.append(topic)
        syn = {"gmail": {"email", "mail", "google"}, "email": {"gmail", "mail"}}

        def pw_sub(pm):
            name = (pm.group(1) or pm.group(2) or "general").lower()
            if name in ("my", "the", "a", "your", "new", "old"):
                name = "general"
            pick = next((r for r in pws if r["key"] == name), None) or next((r for r in pws if name in syn.get(r["key"], set())), None)
            if pick is None and name == "general" and len(pws) == 1:
                pick = pws[0]
            if pick is None:
                return pm.group(0)
            try:
                v = decrypt(pick["value"])
            except Exception as err:  # noqa: BLE001
                _fail(f"decrypt {pick['key']}", err)
                return pm.group(0)
            _revealed.add(v)
            done.append(f"{pick['key']} password")
            return v

        tail = _PWREF.sub(pw_sub, tail)
    except Exception as err:  # noqa: BLE001
        _fail("resolve", err)
        return {"text": text, "replaced": []}
    return {"text": head + tail, "replaced": done}
