"""Step 5 against the REAL backend process, over its stdin/stdout, as Electron uses it."""
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from helpers import BackendProcess


class StorageServerCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="fidex-data-")
        self.addCleanup(self._tmp.cleanup)  # last
        self.data_dir = Path(self._tmp.name)
        self.db_file = self.data_dir / "db" / "fidex.sqlite"
        self._seq = 0

    def start(self, data_dir="default"):
        be = BackendProcess(data_dir=self.data_dir if data_dir == "default" else data_dir)
        self.addCleanup(be.close)  # before the folder is removed
        return be

    def ask(self, be, type_, payload=None):
        self._seq += 1
        return be.request(f"r{self._seq}", type_, payload)

    def ok(self, be, type_, payload=None):
        res = self.ask(be, type_, payload)
        self.assertTrue(res["ok"], res)
        return res["data"]

    def fails(self, be, type_, payload, code):
        res = self.ask(be, type_, payload)
        self.assertFalse(res["ok"], res)
        self.assertEqual(res["error"]["code"], code, res)
        return res["error"]


class StartupTests(StorageServerCase):
    def test_database_is_created_when_the_backend_starts(self):
        be = self.start()  # waits for the 'ready' handshake; no database request has been made
        self.assertEqual(be.ready["event"], "ready")
        self.assertTrue(self.db_file.is_file(), "database file exists before the first request")
        conn = sqlite3.connect(str(self.db_file))
        try:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            conn.close()
        self.assertTrue({"conversations", "messages", "tasks"} <= tables)

    def test_db_status_over_the_protocol_hides_paths(self):
        be = self.start()
        data = self.ok(be, "db.status")
        self.assertTrue(data["ready"])
        self.assertEqual(data["counts"], {"conversations": 0, "messages": 0, "tasks": 0})
        self.assertNotIn(str(self.data_dir), str(data))

    def test_backend_info_lists_the_storage_requests(self):
        be = self.start()
        listed = self.ok(be, "backend.info")["handlers"]
        for name in ("db.status", "conversation.create", "message.list", "task.update"):
            self.assertIn(name, listed)

    def test_without_a_data_folder_the_backend_still_runs_and_reports_it(self):
        be = self.start(data_dir=None)
        self.assertTrue(self.ok(be, "hello", {"message": "hi"})["reply"])
        err = self.fails(be, "conversation.list", {}, "DB_UNAVAILABLE")
        self.assertNotIn("Traceback", err["message"])
        self.assertTrue(self.ask(be, "ping")["ok"])

    def test_unicode_data_folder(self):
        folder = self.data_dir / "données ü ✓"
        be = self.start(data_dir=folder)
        self.assertTrue(self.ok(be, "conversation.create", {"title": "ünï"})["id"])
        self.assertTrue((folder / "db" / "fidex.sqlite").is_file())

    def test_a_damaged_database_at_startup_is_replaced_and_the_backend_starts(self):
        self.db_file.parent.mkdir(parents=True)
        garbage = b"not a database " * 100
        self.db_file.write_bytes(garbage)
        be = self.start()
        data = self.ok(be, "db.status")
        self.assertTrue(data["recovered_from_damage"])
        kept = [p for p in self.db_file.parent.iterdir() if ".corrupt-" in p.name]
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].read_bytes(), garbage)
        self.ok(be, "conversation.create", {"title": "works again"})


class OperationTests(StorageServerCase):
    def test_create_read_update_delete_over_the_protocol(self):
        be = self.start()
        conv = self.ok(be, "conversation.create", {"title": "Over the wire"})
        self.assertEqual(self.ok(be, "conversation.get", {"id": conv["id"]})["title"], "Over the wire")
        m = self.ok(be, "message.create", {"conversation_id": conv["id"], "role": "user", "content": "héllo ✓ \U0001f680"})
        self.assertEqual(self.ok(be, "message.get", {"id": m["id"]})["content"], "héllo ✓ \U0001f680")
        t = self.ok(be, "task.create", {"title": "do it", "conversation_id": conv["id"]})
        self.assertEqual(self.ok(be, "task.update", {"id": t["id"], "status": "completed"})["status"], "completed")
        self.assertEqual(self.ok(be, "message.list", {"conversation_id": conv["id"]})["total"], 1)
        self.assertEqual(self.ok(be, "conversation.update", {"id": conv["id"], "title": "Renamed"})["title"], "Renamed")
        self.assertTrue(self.ok(be, "task.delete", {"id": t["id"]})["deleted"])
        self.assertEqual(self.ok(be, "conversation.delete", {"id": conv["id"]})["messages_deleted"], 1)
        self.fails(be, "conversation.get", {"id": conv["id"]}, "NOT_FOUND")

    def test_invalid_database_requests_are_refused_and_the_backend_survives(self):
        be = self.start()
        cases = [
            ("conversation.create", {"title": ""}, "INVALID_PAYLOAD"),
            ("conversation.create", {"nope": 1}, "INVALID_PAYLOAD"),
            ("conversation.get", {}, "INVALID_PAYLOAD"),
            ("conversation.get", {"id": "x' OR '1'='1"}, "INVALID_PAYLOAD"),
            ("conversation.get", {"id": "unknown"}, "NOT_FOUND"),
            ("message.create", {"conversation_id": "unknown", "role": "user", "content": "x"}, "NOT_FOUND"),
            ("message.create", {"conversation_id": "x", "role": "wizard", "content": "x"}, "INVALID_PAYLOAD"),
            ("task.create", {"title": "t", "status": "someday"}, "INVALID_PAYLOAD"),
            ("task.update", {"id": "unknown", "status": "completed"}, "NOT_FOUND"),
            ("task.list", {"limit": 100000}, "INVALID_PAYLOAD"),
        ]
        for type_, payload, code in cases:
            with self.subTest(type=type_, payload=payload):
                self.fails(be, type_, payload, code)
        be.send_raw(b'{"id":"s","type":"message.create","payload":{"conversation_id":"c","role":"user","content":"\\ud800"}}\n')
        res = be.read()  # a lone surrogate in JSON must be refused, not crash the handler
        self.assertFalse(res["ok"])
        self.assertIn(res["error"]["code"], ("INVALID_PAYLOAD", "NOT_FOUND"))
        self.assertTrue(self.ask(be, "ping")["ok"])
        self.assertIsNone(be.proc.poll())

    def test_a_duplicate_id_is_refused_over_the_protocol(self):
        be = self.start()
        self.ok(be, "conversation.create", {"id": "fixed-id", "title": "first"})
        self.fails(be, "conversation.create", {"id": "fixed-id", "title": "second"}, "DUPLICATE_ID")
        self.assertEqual(self.ok(be, "conversation.get", {"id": "fixed-id"})["title"], "first")

    def test_parallel_requests_get_distinct_message_numbers(self):
        be = self.start()
        cid = self.ok(be, "conversation.create", {})["id"]
        for _ in range(4):  # stays below the backend's 8-requests-at-once limit
            for n in range(6):
                be.send({"id": f"p{self._seq}-{n}", "type": "message.create", "payload": {"conversation_id": cid, "role": "user", "content": f"m{n}"}})
            replies = [be.read() for _ in range(6)]
            self.assertTrue(all(r["ok"] for r in replies), replies)
            self._seq += 1
        seqs = [m["seq"] for m in self.ok(be, "message.list", {"conversation_id": cid, "limit": 100})["items"]]
        self.assertEqual(seqs, list(range(1, 25)))


class PersistenceTests(StorageServerCase):
    def populate(self, be):
        conv = self.ok(be, "conversation.create", {"title": "Remember this"})
        m1 = self.ok(be, "message.create", {"conversation_id": conv["id"], "role": "user", "content": "first ✓"})
        m2 = self.ok(be, "message.create", {"conversation_id": conv["id"], "role": "assistant", "content": "second"})
        task = self.ok(be, "task.create", {"title": "Finish", "conversation_id": conv["id"]})
        task = self.ok(be, "task.update", {"id": task["id"], "status": "in_progress"})
        gone = self.ok(be, "conversation.create", {"title": "temporary"})
        self.ok(be, "conversation.delete", {"id": gone["id"]})
        return conv, m1, m2, task, gone

    def check(self, be, conv, m1, m2, task, gone):
        self.assertEqual(self.ok(be, "conversation.get", {"id": conv["id"]})["title"], "Remember this")
        items = self.ok(be, "message.list", {"conversation_id": conv["id"]})["items"]
        self.assertEqual([m["id"] for m in items], [m1["id"], m2["id"]])
        self.assertEqual(items[0]["content"], "first ✓")
        self.assertEqual(self.ok(be, "task.get", {"id": task["id"]}), task)
        self.fails(be, "conversation.get", {"id": gone["id"]}, "NOT_FOUND")
        self.assertEqual(self.ok(be, "db.status")["counts"], {"conversations": 1, "messages": 2, "tasks": 1})

    def test_data_survives_a_normal_close_and_reopen(self):
        first = self.start()
        records = self.populate(first)
        first.close()  # closes stdin: the backend shuts down on its own
        self.assertIsNotNone(first.proc.poll())
        second = self.start()
        self.check(second, *records)

    def test_data_survives_the_backend_being_killed(self):
        first = self.start()
        records = self.populate(first)
        first.kill()  # no goodbye at all: committed data must still be there
        second = self.start()
        self.check(second, *records)

    def test_data_survives_after_the_shutdown_request(self):
        first = self.start()
        records = self.populate(first)
        res = first.request("bye", "shutdown")
        self.assertTrue(res["ok"])
        first.close()
        self.check(self.start(), *records)

    def test_new_records_after_reopening_continue_the_numbering(self):
        first = self.start()
        conv, *_ = self.populate(first)
        first.close()
        second = self.start()
        self.assertEqual(self.ok(second, "message.create", {"conversation_id": conv["id"], "role": "user", "content": "third"})["seq"], 3)


if __name__ == "__main__":
    unittest.main()
