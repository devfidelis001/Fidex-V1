"""Step 5: the shared storage manager and the request handlers, in-process."""
import tempfile
import unittest
from pathlib import Path

from helpers import BACKEND_DIR  # noqa: F401
from app import handlers
from app.protocol import DB_UNAVAILABLE, DUPLICATE_ID, INVALID_PAYLOAD, NOT_FOUND, RequestError
from app.storage import DATA_DIR_ENV, Storage, storage


def call(name, payload=None):
    return handlers.HANDLERS[name]({} if payload is None else payload)


class StorageManagerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="fidex-store-")
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.store = Storage()
        self.addCleanup(self.store.close)

    def test_not_configured_reports_unavailable(self):
        with self.assertRaises(RequestError) as ctx:
            self.store.get()
        self.assertEqual(ctx.exception.code, DB_UNAVAILABLE)

    def test_init_from_environment_creates_the_database_immediately(self):
        self.assertTrue(self.store.init_from_environment({DATA_DIR_ENV: str(self.dir)}))
        self.assertTrue((self.dir / "db" / "fidex.sqlite").is_file())
        self.assertEqual(self.store.get().status()["schema_version"], 2)

    def test_missing_or_relative_data_dir_disables_storage_without_raising(self):
        for env in ({}, {DATA_DIR_ENV: ""}, {DATA_DIR_ENV: "   "}, {DATA_DIR_ENV: "relative/path"}):
            with self.subTest(env=env):
                self.assertFalse(self.store.init_from_environment(env))
                with self.assertRaises(RequestError) as ctx:
                    self.store.get()
                self.assertEqual(ctx.exception.code, DB_UNAVAILABLE)
        self.assertEqual(list(self.dir.iterdir()), [], "nothing is created in the wrong place")

    def test_get_returns_the_same_open_database(self):
        self.store.init_from_environment({DATA_DIR_ENV: str(self.dir)})
        self.assertIs(self.store.get(), self.store.get())

    def test_a_closed_database_is_reopened_on_the_next_request(self):
        self.store.init_from_environment({DATA_DIR_ENV: str(self.dir)})
        first = self.store.get()
        c = first.create_conversation("survives")
        first.close()
        again = self.store.get()
        self.assertTrue(again.is_open)
        self.assertEqual(again.get_conversation(c["id"])["title"], "survives")

    def test_a_startup_failure_heals_once_the_problem_is_gone(self):
        blocker = self.dir / "blocked"
        blocker.write_text("a file where a folder is needed")
        self.assertFalse(self.store.init_from_environment({DATA_DIR_ENV: str(blocker)}))
        with self.assertRaises(RequestError) as ctx:
            self.store.get()
        self.assertEqual(ctx.exception.code, DB_UNAVAILABLE)
        blocker.unlink()
        self.assertTrue(self.store.get().is_open)


class HandlerTests(unittest.TestCase):
    """The handlers use the module-level `storage`; point it at a temporary folder."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="fidex-handlers-")
        self.addCleanup(self._tmp.cleanup)
        storage.configure(Path(self._tmp.name) / "db" / "fidex.sqlite")
        self.addCleanup(storage.configure, None)  # closes the file, then un-configures
        # order of cleanups: configure(None) runs before _tmp.cleanup (LIFO)

    def assertFails(self, code, name, payload=None):
        with self.assertRaises(RequestError) as ctx:
            call(name, payload)
        self.assertEqual(ctx.exception.code, code, ctx.exception.message)
        return ctx.exception

    def test_all_storage_request_types_are_registered(self):
        expected = {"db.status"} | {f"{kind}.{op}" for kind in ("conversation", "message", "task") for op in ("create", "get", "list", "update", "delete")}
        self.assertTrue(expected <= set(handlers.HANDLERS), expected - set(handlers.HANDLERS))
        info = call("backend.info")
        self.assertTrue(expected <= set(info["handlers"]))

    def test_full_round_trip_through_the_handlers(self):
        conv = call("conversation.create", {"title": "Trip"})
        m1 = call("message.create", {"conversation_id": conv["id"], "role": "user", "content": "Plan a trip"})
        m2 = call("message.create", {"conversation_id": conv["id"], "role": "assistant", "content": "Where to?"})
        task = call("task.create", {"title": "Book hotel", "conversation_id": conv["id"]})
        done = call("task.update", {"id": task["id"], "status": "completed"})
        self.assertEqual(done["status"], "completed")
        self.assertEqual([m["id"] for m in call("message.list", {"conversation_id": conv["id"]})["items"]], [m1["id"], m2["id"]])
        self.assertEqual(call("conversation.get", {"id": conv["id"]})["message_count"], 2)
        self.assertEqual(call("task.list", {"status": "completed"})["total"], 1)
        self.assertEqual(call("conversation.update", {"id": conv["id"], "title": "Trip 2"})["title"], "Trip 2")
        self.assertEqual(call("message.update", {"id": m1["id"], "content": "Plan a long trip"})["content"], "Plan a long trip")
        self.assertTrue(call("message.delete", {"id": m2["id"]})["deleted"])
        self.assertTrue(call("task.delete", {"id": task["id"]})["deleted"])
        self.assertEqual(call("conversation.delete", {"id": conv["id"]})["messages_deleted"], 1)
        self.assertEqual(call("db.status")["counts"], {"conversations": 0, "messages": 0, "tasks": 0})

    def test_unknown_fields_are_rejected_not_ignored(self):
        conv = call("conversation.create", {})
        for name, payload in [
            ("db.status", {"x": 1}),
            ("conversation.create", {"titel": "typo"}),
            ("conversation.get", {"id": conv["id"], "extra": 1}),
            ("conversation.list", {"page": 2}),
            ("message.create", {"conversation_id": conv["id"], "role": "user", "content": "x", "colour": "red"}),
            ("task.create", {"title": "t", "priority": 1}),
            ("task.update", {"id": "x", "priority": 1}),
        ]:
            with self.subTest(name=name):
                err = self.assertFails(INVALID_PAYLOAD, name, payload)
                self.assertIn("Unknown field", err.message)

    def test_missing_required_fields_are_rejected(self):
        for name in ("conversation.get", "conversation.update", "conversation.delete", "message.create", "message.get", "message.list", "message.update", "message.delete", "task.create", "task.get", "task.update", "task.delete"):
            with self.subTest(name=name):
                err = self.assertFails(INVALID_PAYLOAD, name, {})
                self.assertIn("Missing field", err.message)
        self.assertFails(INVALID_PAYLOAD, "conversation.update", {"id": "x"})
        self.assertFails(INVALID_PAYLOAD, "task.update", {"id": "x"})  # nothing to change

    def test_wrong_types_are_rejected(self):
        for name, payload in [
            ("conversation.get", {"id": 5}),
            ("conversation.get", {"id": None}),
            ("conversation.create", {"title": 5}),
            ("message.create", {"conversation_id": "x", "role": 1, "content": "c"}),
            ("task.create", {"title": None}),
            ("task.list", {"limit": "ten"}),
        ]:
            with self.subTest(name=name, payload=payload):
                self.assertFails(INVALID_PAYLOAD, name, payload)

    def test_not_found_and_duplicates(self):
        self.assertFails(NOT_FOUND, "conversation.get", {"id": "missing"})
        self.assertFails(NOT_FOUND, "message.create", {"conversation_id": "missing", "role": "user", "content": "x"})
        call("conversation.create", {"id": "same"})
        self.assertFails(DUPLICATE_ID, "conversation.create", {"id": "same"})

    def test_requests_report_unavailable_when_storage_is_not_configured(self):
        storage.configure(None)
        for name, payload in [("db.status", {}), ("conversation.list", {}), ("task.create", {"title": "t"})]:
            with self.subTest(name=name):
                self.assertFails(DB_UNAVAILABLE, name, payload)


if __name__ == "__main__":
    unittest.main()
