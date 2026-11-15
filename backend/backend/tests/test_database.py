"""Step 5: the SQLite layer (app/database.py), tested directly against real database files."""
import itertools
import os
import re
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from helpers import BACKEND_DIR  # noqa: F401  (puts backend/ on sys.path)
from app import database as dbmod
from app.database import Database
from app.protocol import (
    DB_ERROR,
    DB_UNAVAILABLE,
    DUPLICATE_ID,
    INVALID_PAYLOAD,
    NOT_FOUND,
    RequestError,
)


def counting_clock():
    """Deterministic, strictly increasing timestamps (one millisecond apart)."""
    counter = itertools.count(1)
    return lambda: "2026-01-01T00:00:%06.3f+00:00" % (next(counter) / 1000.0)


class DbTestCase(unittest.TestCase):
    """Gives every test a fresh temporary folder and an open Database (always closed afterwards)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="fidex-db-")
        self.addCleanup(self._tmp.cleanup)  # runs last
        self.dir = Path(self._tmp.name)
        self.path = self.dir / "db" / "fidex.sqlite"
        self.db = Database(self.path, clock=counting_clock()).open()
        self.addCleanup(self.db.close)  # runs before the folder is removed (Windows needs this)

    def raw(self):
        """A second, independent connection that looks at the file the way any other program would."""
        conn = sqlite3.connect(str(self.path))
        self.addCleanup(conn.close)
        return conn

    def assertRequestError(self, code, func, *args, **kwargs):
        with self.assertRaises(RequestError) as ctx:
            func(*args, **kwargs)
        self.assertEqual(ctx.exception.code, code, ctx.exception.message)
        return ctx.exception


# ------------------------------------------------------------------------------ creation
class CreationTests(DbTestCase):
    def test_database_file_and_folders_are_created_automatically(self):
        self.assertTrue(self.path.is_file())
        self.assertTrue(self.path.parent.is_dir())

    def test_the_three_tables_exist(self):
        names = {r[0] for r in self.raw().execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"conversations", "messages", "tasks"} <= names)

    def test_tables_have_id_and_timestamp_columns(self):
        for table in ("conversations", "messages", "tasks"):
            cols = {r[1]: r for r in self.raw().execute(f"PRAGMA table_info({table})")}
            for name in ("id", "created_at", "updated_at"):
                self.assertIn(name, cols, f"{table}.{name}")
            self.assertEqual(cols["id"][5], 1, f"{table}.id is the primary key")

    def test_schema_version_is_recorded(self):
        self.assertEqual(self.raw().execute("PRAGMA user_version").fetchone()[0], dbmod.SCHEMA_VERSION)

    def test_open_is_idempotent(self):
        self.assertIs(self.db.open(), self.db)
        self.assertTrue(self.db.is_open)

    def test_empty_file_is_accepted_and_gets_the_schema(self):
        other = self.dir / "empty.sqlite"
        other.write_bytes(b"")
        with Database(other) as db:
            self.assertEqual(db.status()["schema_version"], dbmod.SCHEMA_VERSION)

    def test_foreign_keys_are_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db._conn.execute(
                "INSERT INTO messages (id, conversation_id, seq, role, content, created_at, updated_at) "
                "VALUES ('m', 'no-such-conversation', 1, 'user', 'x', 't', 't')"
            )

    def test_unicode_folder_name_works(self):
        path = self.dir / "données-ü ✓" / "db" / "fidex.sqlite"
        with Database(path) as db:
            self.assertEqual(db.create_conversation("ok")["title"], "ok")
        self.assertTrue(path.is_file())

    def test_status_has_counts_and_no_file_path(self):
        c = self.db.create_conversation("a")
        self.db.create_message(c["id"], "user", "hi")
        self.db.create_task("t")
        status = self.db.status()
        self.assertEqual(status["counts"], {"conversations": 1, "messages": 1, "tasks": 1})
        self.assertTrue(status["ready"])
        self.assertFalse(status["recovered_from_damage"])
        self.assertNotIn(str(self.dir), repr(status), "the interface must never learn file paths")


# ------------------------------------------------------------------------------ conversations
class ConversationTests(DbTestCase):
    def test_create_and_get(self):
        created = self.db.create_conversation("Plan my week")
        self.assertEqual(created["title"], "Plan my week")
        self.assertEqual(created["message_count"], 0)
        self.assertEqual(created["created_at"], created["updated_at"])
        self.assertRegex(created["created_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$")
        self.assertEqual(self.db.get_conversation(created["id"]), created)

    def test_default_title_and_trimming(self):
        self.assertEqual(self.db.create_conversation()["title"], dbmod.DEFAULT_CONVERSATION_TITLE)
        self.assertEqual(self.db.create_conversation("  spaced  ")["title"], "spaced")

    def test_ids_are_unique_and_well_formed(self):
        ids = [self.db.create_conversation()["id"] for _ in range(200)]
        self.assertEqual(len(set(ids)), 200)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{32}", i) for i in ids))

    def test_caller_supplied_id_is_kept(self):
        self.assertEqual(self.db.create_conversation("x", id="conv_1-A")["id"], "conv_1-A")

    def test_duplicate_id_is_refused_and_original_is_untouched(self):
        self.db.create_conversation("first", id="same")
        self.assertRequestError(DUPLICATE_ID, self.db.create_conversation, "second", id="same")
        self.assertEqual(self.db.get_conversation("same")["title"], "first")
        self.assertEqual(self.db.list_conversations()["total"], 1)

    def test_get_missing_is_not_found(self):
        self.assertRequestError(NOT_FOUND, self.db.get_conversation, "nope")

    def test_list_is_newest_activity_first_and_paginated(self):
        a, b, c = (self.db.create_conversation(t) for t in "abc")
        self.db.update_conversation(a["id"], "a2")  # a becomes the most recently changed
        listed = self.db.list_conversations()
        self.assertEqual([i["title"] for i in listed["items"]], ["a2", "c", "b"])
        self.assertEqual(listed["total"], 3)
        page = self.db.list_conversations(limit=1, offset=1)
        self.assertEqual([i["title"] for i in page["items"]], ["c"])
        self.assertEqual((page["limit"], page["offset"], page["total"]), (1, 1, 3))
        self.assertEqual(self.db.list_conversations(offset=10)["items"], [])

    def test_update_changes_title_and_updated_at_only(self):
        c = self.db.create_conversation("old")
        u = self.db.update_conversation(c["id"], "new")
        self.assertEqual(u["title"], "new")
        self.assertEqual(u["created_at"], c["created_at"])
        self.assertGreater(u["updated_at"], c["updated_at"])

    def test_update_missing_is_not_found(self):
        self.assertRequestError(NOT_FOUND, self.db.update_conversation, "nope", "x")

    def test_delete_removes_conversation_and_its_messages(self):
        c = self.db.create_conversation("x")
        for i in range(3):
            self.db.create_message(c["id"], "user", f"m{i}")
        keep = self.db.create_conversation("keep")
        self.db.create_message(keep["id"], "user", "stay")
        out = self.db.delete_conversation(c["id"])
        self.assertEqual(out, {"deleted": True, "id": c["id"], "messages_deleted": 3})
        self.assertRequestError(NOT_FOUND, self.db.get_conversation, c["id"])
        self.assertEqual(self.raw().execute("SELECT COUNT(*) FROM messages").fetchone()[0], 1)
        self.assertEqual(self.db.get_conversation(keep["id"])["message_count"], 1)

    def test_delete_missing_is_not_found(self):
        self.assertRequestError(NOT_FOUND, self.db.delete_conversation, "nope")

    def test_invalid_titles(self):
        for bad in ("", "   ", "x" * (dbmod.MAX_TITLE_CHARS + 1), 5, [], {"a": 1}, "a\x00b", "lone \ud800 surrogate", True):
            with self.subTest(title=repr(bad)[:30]):
                self.assertRequestError(INVALID_PAYLOAD, self.db.create_conversation, bad)
        self.assertEqual(self.db.list_conversations()["total"], 0, "nothing was stored by the failed attempts")

    def test_title_at_the_limit_is_accepted(self):
        self.assertEqual(len(self.db.create_conversation("x" * dbmod.MAX_TITLE_CHARS)["title"]), dbmod.MAX_TITLE_CHARS)

    def test_invalid_ids(self):
        for bad in ("", " ", "a b", "../x", "x" * 65, "-leading", "semi;colon", "q'uote", 5, None, ["a"], "' OR 1=1 --"):
            with self.subTest(id=repr(bad)):
                self.assertRequestError(INVALID_PAYLOAD, self.db.get_conversation, bad)
                self.assertRequestError(INVALID_PAYLOAD, self.db.delete_conversation, bad)

    def test_bad_paging_values(self):
        for kwargs in ({"limit": 0}, {"limit": -1}, {"limit": 501}, {"limit": "5"}, {"limit": 1.5}, {"limit": True}, {"offset": -1}, {"offset": "0"}):
            with self.subTest(**kwargs):
                self.assertRequestError(INVALID_PAYLOAD, self.db.list_conversations, **kwargs)


# ------------------------------------------------------------------------------ messages
class MessageTests(DbTestCase):
    def setUp(self):
        super().setUp()
        self.conv = self.db.create_conversation("chat")

    def test_create_and_retrieve(self):
        m = self.db.create_message(self.conv["id"], "user", "Hello")
        self.assertEqual((m["role"], m["content"], m["seq"], m["conversation_id"]), ("user", "Hello", 1, self.conv["id"]))
        self.assertEqual(m["created_at"], m["updated_at"])
        self.assertEqual(self.db.get_message(m["id"]), m)

    def test_messages_keep_their_order(self):
        for i, role in enumerate(["user", "assistant", "user", "system"]):
            self.db.create_message(self.conv["id"], role, f"text {i}")
        items = self.db.list_messages(self.conv["id"])["items"]
        self.assertEqual([m["content"] for m in items], [f"text {i}" for i in range(4)])
        self.assertEqual([m["seq"] for m in items], [1, 2, 3, 4])

    def test_pagination(self):
        for i in range(5):
            self.db.create_message(self.conv["id"], "user", str(i))
        page = self.db.list_messages(self.conv["id"], limit=2, offset=2)
        self.assertEqual([m["content"] for m in page["items"]], ["2", "3"])
        self.assertEqual(page["total"], 5)

    def test_numbering_is_per_conversation(self):
        other = self.db.create_conversation("other")
        self.db.create_message(self.conv["id"], "user", "a")
        self.assertEqual(self.db.create_message(other["id"], "user", "b")["seq"], 1)
        self.assertEqual(self.db.create_message(self.conv["id"], "user", "c")["seq"], 2)

    def test_new_message_touches_the_conversation(self):
        before = self.db.get_conversation(self.conv["id"])
        self.db.create_message(self.conv["id"], "user", "hi")
        after = self.db.get_conversation(self.conv["id"])
        self.assertGreater(after["updated_at"], before["updated_at"])
        self.assertEqual(after["message_count"], 1)

    def test_unicode_and_multiline_content_survive(self):
        text = "Olá, мир! 你好 ✓ \U0001f680\nsecond line\t'quoted' \"double\" \\ backslash"
        m = self.db.create_message(self.conv["id"], "assistant", text)
        self.assertEqual(self.db.get_message(m["id"])["content"], text)

    def test_content_is_stored_exactly_as_given(self):
        m = self.db.create_message(self.conv["id"], "user", "  padded  \n")
        self.assertEqual(self.db.get_message(m["id"])["content"], "  padded  \n")

    def test_content_at_the_limit(self):
        m = self.db.create_message(self.conv["id"], "user", "x" * dbmod.MAX_CONTENT_CHARS)
        self.assertEqual(len(self.db.get_message(m["id"])["content"]), dbmod.MAX_CONTENT_CHARS)

    def test_update_changes_content_and_updated_at(self):
        m = self.db.create_message(self.conv["id"], "user", "old")
        u = self.db.update_message(m["id"], "new")
        self.assertEqual(u["content"], "new")
        self.assertEqual((u["created_at"], u["seq"], u["role"]), (m["created_at"], m["seq"], m["role"]))
        self.assertGreater(u["updated_at"], m["updated_at"])

    def test_delete_message(self):
        a = self.db.create_message(self.conv["id"], "user", "a")
        b = self.db.create_message(self.conv["id"], "user", "b")
        self.assertEqual(self.db.delete_message(a["id"]), {"deleted": True, "id": a["id"]})
        self.assertRequestError(NOT_FOUND, self.db.get_message, a["id"])
        self.assertEqual([m["id"] for m in self.db.list_messages(self.conv["id"])["items"]], [b["id"]])
        self.assertEqual(self.db.get_conversation(self.conv["id"])["message_count"], 1)

    def test_missing_records_are_not_found(self):
        self.assertRequestError(NOT_FOUND, self.db.get_message, "nope")
        self.assertRequestError(NOT_FOUND, self.db.update_message, "nope", "x")
        self.assertRequestError(NOT_FOUND, self.db.delete_message, "nope")
        self.assertRequestError(NOT_FOUND, self.db.create_message, "no-conv", "user", "x")
        self.assertRequestError(NOT_FOUND, self.db.list_messages, "no-conv")
        self.assertEqual(self.raw().execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)

    def test_duplicate_message_id(self):
        self.db.create_message(self.conv["id"], "user", "first", id="dup")
        self.assertRequestError(DUPLICATE_ID, self.db.create_message, self.conv["id"], "user", "second", id="dup")
        self.assertEqual(self.db.get_message("dup")["content"], "first")
        self.assertEqual(self.db.list_messages(self.conv["id"])["total"], 1)

    def test_invalid_messages_store_nothing(self):
        cid = self.conv["id"]
        bad = [
            ("tool", "x"), ("", "x"), (None, "x"), (5, "x"), ("USER", "x"),  # roles
            ("user", ""), ("user", "   "), ("user", None), ("user", 5), ("user", ["x"]),  # contents
            ("user", "x" * (dbmod.MAX_CONTENT_CHARS + 1)), ("user", "nul\x00byte"), ("user", "\udc80"),
        ]
        for role, content in bad:
            with self.subTest(role=role, content=repr(content)[:20]):
                self.assertRequestError(INVALID_PAYLOAD, self.db.create_message, cid, role, content)
        self.assertEqual(self.raw().execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)

    def test_update_with_invalid_content_changes_nothing(self):
        m = self.db.create_message(self.conv["id"], "user", "keep")
        for bad in ("", "  ", None, 3, "x" * (dbmod.MAX_CONTENT_CHARS + 1)):
            self.assertRequestError(INVALID_PAYLOAD, self.db.update_message, m["id"], bad)
        self.assertEqual(self.db.get_message(m["id"]), m)


# ------------------------------------------------------------------------------ tasks
class TaskTests(DbTestCase):
    def test_create_with_defaults(self):
        t = self.db.create_task("Book flights")
        self.assertEqual((t["title"], t["description"], t["status"], t["conversation_id"], t["completed_at"]), ("Book flights", "", "pending", None, None))
        self.assertEqual(t["created_at"], t["updated_at"])
        self.assertEqual(self.db.get_task(t["id"]), t)

    def test_create_with_everything(self):
        c = self.db.create_conversation("c")
        t = self.db.create_task("T", description="details\nmore", status="in_progress", conversation_id=c["id"], id="task-1")
        self.assertEqual((t["id"], t["status"], t["conversation_id"], t["description"]), ("task-1", "in_progress", c["id"], "details\nmore"))

    def test_creating_a_completed_task_sets_completed_at(self):
        t = self.db.create_task("done already", status="completed")
        self.assertEqual(t["completed_at"], t["created_at"])

    def test_update_status_lifecycle(self):
        t = self.db.create_task("job")
        started = self.db.update_task(t["id"], {"status": "in_progress"})
        self.assertEqual((started["status"], started["completed_at"]), ("in_progress", None))
        done = self.db.update_task(t["id"], {"status": "completed"})
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["completed_at"], done["updated_at"])
        again = self.db.update_task(t["id"], {"title": "renamed"})  # completed stays completed, time unchanged
        self.assertEqual(again["completed_at"], done["completed_at"])
        reopened = self.db.update_task(t["id"], {"status": "pending"})
        self.assertIsNone(reopened["completed_at"])
        self.assertEqual(reopened["created_at"], t["created_at"])

    def test_update_only_touches_given_fields(self):
        t = self.db.create_task("title", description="desc")
        u = self.db.update_task(t["id"], {"description": "new desc"})
        self.assertEqual((u["title"], u["description"], u["status"]), ("title", "new desc", "pending"))
        self.assertEqual(self.db.update_task(t["id"], {"description": ""})["description"], "")

    def test_update_rejects_empty_unknown_and_invalid(self):
        t = self.db.create_task("job")
        for fields in ({}, {"colour": "red"}, {"status": "done"}, {"status": None}, {"title": ""}, {"title": 3}, {"description": 3}, {"id": "x"}, None, []):
            with self.subTest(fields=fields):
                self.assertRequestError(INVALID_PAYLOAD, self.db.update_task, t["id"], fields)
        self.assertEqual(self.db.get_task(t["id"]), t)

    def test_update_missing_is_not_found(self):
        self.assertRequestError(NOT_FOUND, self.db.update_task, "nope", {"status": "completed"})

    def test_delete(self):
        t = self.db.create_task("gone")
        self.assertEqual(self.db.delete_task(t["id"]), {"deleted": True, "id": t["id"]})
        self.assertRequestError(NOT_FOUND, self.db.get_task, t["id"])
        self.assertRequestError(NOT_FOUND, self.db.delete_task, t["id"])

    def test_list_filters_and_paging(self):
        c = self.db.create_conversation("c")
        t1 = self.db.create_task("one", conversation_id=c["id"])
        t2 = self.db.create_task("two", status="completed")
        t3 = self.db.create_task("three", conversation_id=c["id"], status="completed")
        every = self.db.list_tasks()
        self.assertEqual([t["title"] for t in every["items"]], ["three", "two", "one"])  # newest first
        self.assertEqual(every["total"], 3)
        self.assertEqual({t["id"] for t in self.db.list_tasks(status="completed")["items"]}, {t2["id"], t3["id"]})
        self.assertEqual({t["id"] for t in self.db.list_tasks(conversation_id=c["id"])["items"]}, {t1["id"], t3["id"]})
        both = self.db.list_tasks(status="completed", conversation_id=c["id"])
        self.assertEqual([t["id"] for t in both["items"]], [t3["id"]])
        self.assertEqual(len(self.db.list_tasks(limit=2)["items"]), 2)
        self.assertEqual(self.db.list_tasks(limit=2, offset=2)["items"][0]["title"], "one")

    def test_list_rejects_bad_filters(self):
        self.assertRequestError(INVALID_PAYLOAD, self.db.list_tasks, status="whatever")
        self.assertRequestError(INVALID_PAYLOAD, self.db.list_tasks, status="pending' OR '1'='1")
        self.assertRequestError(INVALID_PAYLOAD, self.db.list_tasks, conversation_id="a b")

    def test_deleting_a_conversation_keeps_its_tasks(self):
        c = self.db.create_conversation("c")
        t = self.db.create_task("survivor", conversation_id=c["id"])
        self.db.delete_conversation(c["id"])
        self.assertIsNone(self.db.get_task(t["id"])["conversation_id"])

    def test_task_for_unknown_conversation_is_refused(self):
        self.assertRequestError(NOT_FOUND, self.db.create_task, "x", conversation_id="missing")
        self.assertEqual(self.db.list_tasks()["total"], 0)

    def test_duplicate_task_id(self):
        self.db.create_task("first", id="dup")
        self.assertRequestError(DUPLICATE_ID, self.db.create_task, "second", id="dup")
        self.assertEqual(self.db.get_task("dup")["title"], "first")

    def test_invalid_task_fields(self):
        for kwargs in ({"title": ""}, {"title": "x" * 201}, {"title": 5}, {"title": "t", "status": "bogus"}, {"title": "t", "description": 5}, {"title": "t", "description": "x" * 10001}):
            with self.subTest(**{k: str(v)[:15] for k, v in kwargs.items()}):
                self.assertRequestError(INVALID_PAYLOAD, self.db.create_task, **kwargs)
        self.assertEqual(self.db.list_tasks()["total"], 0)


# ------------------------------------------------------------------------------ persistence
class PersistenceTests(unittest.TestCase):
    def test_everything_survives_closing_and_reopening(self):
        with tempfile.TemporaryDirectory(prefix="fidex-persist-") as tmp:
            path = Path(tmp) / "db" / "fidex.sqlite"
            db = Database(path).open()
            conv = db.create_conversation("Persistent chat")
            m1 = db.create_message(conv["id"], "user", "Remember me ✓")
            m2 = db.create_message(conv["id"], "assistant", "I will")
            task = db.create_task("Finish step 5", conversation_id=conv["id"])
            db.update_task(task["id"], {"status": "completed"})
            task = db.get_task(task["id"])
            doomed = db.create_conversation("will be deleted")
            db.delete_conversation(doomed["id"])
            before = db.status()["counts"]
            db.close()

            reopened = Database(path).open()
            try:
                self.assertEqual(reopened.get_conversation(conv["id"])["title"], "Persistent chat")
                self.assertEqual([m["id"] for m in reopened.list_messages(conv["id"])["items"]], [m1["id"], m2["id"]])
                self.assertEqual(reopened.get_message(m1["id"])["content"], "Remember me ✓")
                self.assertEqual(reopened.get_task(task["id"]), task)
                self.assertEqual(reopened.status()["counts"], before)
                with self.assertRaises(RequestError):
                    reopened.get_conversation(doomed["id"])  # a deletion persisted too
                self.assertEqual(reopened.create_message(conv["id"], "user", "later")["seq"], 3)
                self.assertFalse(reopened.recovered_from)
            finally:
                reopened.close()

    def test_a_second_independent_reader_sees_committed_data(self):
        with tempfile.TemporaryDirectory(prefix="fidex-persist-") as tmp:
            path = Path(tmp) / "fidex.sqlite"
            with Database(path) as db:
                db.create_conversation("visible")
                other = sqlite3.connect(str(path))
                try:
                    self.assertEqual(other.execute("SELECT title FROM conversations").fetchone()[0], "visible")
                finally:
                    other.close()


# ------------------------------------------------------------------------------ safety
class SafetyTests(DbTestCase):
    HOSTILE = [
        "Robert'); DROP TABLE conversations;--",
        "' OR '1'='1",
        '"; DELETE FROM messages; --',
        "%s %d {0} ${x} `rm -rf`",
        "\u202e reversed \u2066 isolates",
    ]

    def test_hostile_text_is_stored_literally_and_harms_nothing(self):
        for text in self.HOSTILE:
            c = self.db.create_conversation(text[:200])
            m = self.db.create_message(c["id"], "user", text)
            t = self.db.create_task(text[:200], description=text)
            self.assertEqual(self.db.get_message(m["id"])["content"], text)
            self.assertEqual(self.db.get_conversation(c["id"])["title"], text[:200].strip())
            self.assertEqual(self.db.get_task(t["id"])["description"], text)
        names = {r[0] for r in self.raw().execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"conversations", "messages", "tasks"} <= names)
        self.assertEqual(self.db.status()["counts"], {"conversations": 5, "messages": 5, "tasks": 5})

    def test_hostile_ids_never_reach_sql(self):
        c = self.db.create_conversation("safe")
        for bad in ("x' OR '1'='1", "1; DROP TABLE conversations", "x" * 65, "a/b"):
            self.assertRequestError(INVALID_PAYLOAD, self.db.get_conversation, bad)
            self.assertRequestError(INVALID_PAYLOAD, self.db.create_message, bad, "user", "x")
        self.assertEqual(self.db.get_conversation(c["id"])["title"], "safe")

    def test_a_failed_transaction_leaves_nothing_behind(self):
        with self.assertRaises(RequestError):
            with self.db._tx() as conn:
                conn.execute("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('half', 't', 'a', 'a')")
                raise RequestError(DB_ERROR, "simulated failure after the first statement")
        self.assertRequestError(NOT_FOUND, self.db.get_conversation, "half")
        self.db.create_conversation("works afterwards")  # the connection is still usable

    def test_the_schema_itself_rejects_bad_rows(self):
        """Last line of defence: even code that skips the Python checks cannot store bad data."""
        bad_statements = [
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('', 't', 'a', 'a')",
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c', '', 'a', 'a')",
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c', NULL, 'a', 'a')",
            "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t', 'x', 'bogus', 'a', 'a')",
            "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t', 'x', 'completed', 'a', 'a')",
            "INSERT INTO tasks (id, title, status, created_at, updated_at, completed_at) VALUES ('t', 'x', 'pending', 'a', 'a', 'a')",
        ]
        for statement in bad_statements:
            with self.subTest(statement=statement[:60]):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db._conn.execute(statement)
        c = self.db.create_conversation("c")
        for seq, role in ((0, "user"), (1, "robot")):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db._conn.execute(
                    "INSERT INTO messages (id, conversation_id, seq, role, content, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'a', 'a')",
                    (f"m{seq}", c["id"], seq, role),
                )
        self.db.create_message(c["id"], "user", "one", id="m-a")
        with self.assertRaises(sqlite3.IntegrityError):  # the same (conversation, seq) twice
            self.db._conn.execute(
                "INSERT INTO messages (id, conversation_id, seq, role, content, created_at, updated_at) VALUES ('m-b', ?, 1, 'user', 'x', 'a', 'a')",
                (c["id"],),
            )

    def test_constraint_violations_inside_a_transaction_become_safe_errors(self):
        with self.assertRaises(RequestError) as ctx:
            with self.db._tx() as conn:
                conn.execute("INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t', 'x', 'bogus', 'a', 'a')")
        self.assertEqual(ctx.exception.code, INVALID_PAYLOAD)
        self.assertNotIn("CHECK", ctx.exception.message)
        self.assertNotIn("tasks", ctx.exception.message)

    def test_concurrent_writers_never_duplicate_or_skip(self):
        conv = self.db.create_conversation("busy")
        errors = []

        def writer(n):
            try:
                for i in range(15):
                    self.db.create_message(conv["id"], "user", f"{n}-{i}")
                    self.db.create_task(f"{n}-{i}")
            except Exception as err:  # noqa: BLE001
                errors.append(err)

        threads = [threading.Thread(target=writer, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(errors, [])
        msgs = self.db.list_messages(conv["id"], limit=500)["items"]
        self.assertEqual([m["seq"] for m in msgs], list(range(1, 121)))
        self.assertEqual(len({m["id"] for m in msgs}), 120)
        self.assertEqual(self.db.list_tasks(limit=500)["total"], 120)


# ------------------------------------------------------------------------------ database errors
class _Exploding:
    """Stands in for a sqlite3 connection that fails on every statement."""

    def __init__(self, error):
        self.error = error

    def execute(self, *args, **kwargs):
        raise self.error

    def close(self):
        pass


class ErrorTests(DbTestCase):
    def break_connection(self, error):
        """Swap the live connection for one that fails; the real one is still closed afterwards."""
        real = self.db._conn
        self.addCleanup(real.close)  # runs before the folder is removed (Windows)
        self.db._conn = _Exploding(error)

    def test_using_a_closed_database_is_reported(self):
        self.db.close()
        self.assertFalse(self.db.is_open)
        self.assertRequestError(DB_UNAVAILABLE, self.db.create_conversation, "x")
        self.assertRequestError(DB_UNAVAILABLE, self.db.status)

    def test_close_twice_is_harmless(self):
        self.db.close()
        self.db.close()

    def test_locked_database_gives_a_busy_error(self):
        self.break_connection(sqlite3.OperationalError("database is locked"))
        err = self.assertRequestError(DB_ERROR, self.db.create_conversation, "x")
        self.assertIn("busy", err.message)

    def test_unknown_sqlite_failure_is_hidden_behind_a_generic_message(self):
        self.break_connection(sqlite3.OperationalError("disk I/O error near SELECT secret FROM somewhere"))
        err = self.assertRequestError(DB_ERROR, self.db.get_conversation, "abc")
        for leak in ("SELECT", "secret", "disk I/O", str(self.dir)):
            self.assertNotIn(leak, err.message)

    def test_corruption_found_while_running_closes_the_connection(self):
        self.break_connection(sqlite3.DatabaseError("database disk image is malformed"))
        self.assertRequestError(DB_UNAVAILABLE, self.db.list_conversations)
        self.assertFalse(self.db.is_open, "a damaged connection is dropped so the next open can repair it")

    def test_garbage_file_is_moved_aside_and_replaced(self):
        path = self.dir / "garbage" / "fidex.sqlite"
        path.parent.mkdir()
        garbage = b"this is definitely not a sqlite database " * 50
        path.write_bytes(garbage)
        with Database(path) as db:
            self.assertIsNotNone(db.recovered_from)
            self.assertTrue(db.status()["recovered_from_damage"])
            self.assertEqual(db.create_conversation("fresh start")["title"], "fresh start")
            kept = path.parent / db.recovered_from
            self.assertTrue(kept.is_file())
            self.assertEqual(kept.read_bytes(), garbage, "the damaged file is kept untouched, never deleted")
            self.assertRegex(kept.name, r"^fidex\.sqlite\.corrupt-\d{8}T\d{6}")
        with Database(path) as again:  # the replacement is a normal database from now on
            self.assertFalse(again.recovered_from)
            self.assertEqual(again.list_conversations()["total"], 1)

    def test_two_damaged_files_do_not_overwrite_each_other(self):
        path = self.dir / "twice" / "fidex.sqlite"
        path.parent.mkdir()
        names = set()
        for n in range(2):
            path.write_bytes(b"garbage number %d " % n * 100)
            with Database(path) as db:
                names.add(db.recovered_from)
        self.assertEqual(len(names), 2)

    def test_database_from_a_newer_version_is_left_alone(self):
        path = self.dir / "newer" / "fidex.sqlite"
        path.parent.mkdir()
        conn = sqlite3.connect(str(path))
        conn.execute("CREATE TABLE future (x)")
        conn.execute("PRAGMA user_version = 99")
        conn.commit()
        conn.close()
        before = path.read_bytes()
        db = Database(path)
        self.assertRequestError(DB_UNAVAILABLE, db.open)
        self.assertFalse(db.is_open)
        self.assertEqual(path.read_bytes(), before, "a newer database is never modified")
        self.assertEqual([p.name for p in path.parent.iterdir()], ["fidex.sqlite"], "and never moved aside")

    def test_a_folder_in_the_way_is_reported_not_raised(self):
        blocker = self.dir / "blocker"
        blocker.write_text("I am a file, not a folder")
        self.assertRequestError(DB_UNAVAILABLE, Database(blocker / "db" / "fidex.sqlite").open)

    def test_a_directory_where_the_file_should_be_is_reported(self):
        path = self.dir / "isdir.sqlite"
        path.mkdir()
        self.assertRequestError(DB_UNAVAILABLE, Database(path).open)

    def test_error_messages_never_leak_paths_or_sql(self):
        cases = [
            lambda: self.db.get_conversation("missing"),
            lambda: self.db.create_message("missing", "user", "x"),
            lambda: self.db.create_conversation(id="a b"),
            lambda: Database(self.dir / "isdir2").open(),
        ]
        (self.dir / "isdir2").mkdir()
        for case in cases:
            with self.assertRaises(RequestError) as ctx:
                case()
            text = ctx.exception.message
            for leak in (str(self.dir), "SELECT", "INSERT", "sqlite", "Traceback"):
                self.assertNotIn(leak, text)


if __name__ == "__main__":
    unittest.main()
