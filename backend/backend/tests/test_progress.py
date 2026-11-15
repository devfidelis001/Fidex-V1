"""Step 6: automatic save progress. Database-level tests plus tests against the REAL backend process
(clean close and reopen, and a hard kill)."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

from helpers import BackendProcess  # noqa: F401  (also puts backend/ on sys.path)

from app import progress
from app.database import Database
from app.protocol import DUPLICATE_ID, INVALID_PAYLOAD, NOT_FOUND, RequestError  # noqa: F401
from test_storage_server import StorageServerCase

STEPS = [
    {"key": "understand", "label": "Understand the objective", "state": "pending"},
    {"key": "plan", "label": "Plan the work", "state": "pending"},
    {"key": "execute", "label": "Carry out approved tasks", "state": "pending"},
]


def steps(*states):
    return [{**s, "state": st} for s, st in zip(STEPS, states)]


class DbCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="fidex-progress-")
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "db" / "fidex.sqlite"
        self.db = Database(self.path).open()
        self.addCleanup(self.db.close)

    def count(self, table):
        return self.db._conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


class SaveTests(DbCase):
    def test_creating_a_task(self):
        res = progress.save(self.db, {"id": "t1", "title": "Build a site", "instruction": "Build a site for my shop", "status": "in_progress", "steps": steps("active", "pending", "pending")})
        self.assertTrue(res["saved"])
        t = self.db.get_task("t1")  # the Step 5 API still reads it
        self.assertEqual((t["title"], t["status"]), ("Build a site", "in_progress"))
        self.assertEqual(self.count("task_steps"), 3)

    def test_new_task_needs_a_title_and_bad_input_saves_nothing(self):
        with self.assertRaises(RequestError) as cm:
            progress.save(self.db, {"id": "t1"})
        self.assertEqual(cm.exception.code, INVALID_PAYLOAD)
        with self.assertRaises(RequestError):
            progress.save(self.db, {"id": "t1", "title": "x", "steps": [{"key": "a", "label": "A", "state": "bogus"}]})
        with self.assertRaises(RequestError):
            progress.save(self.db, {"id": "t1", "title": "x", "nope": 1})
        self.assertEqual(self.count("tasks"), 0)

    def test_updating_progress_only_moves_forward(self):
        progress.save(self.db, {"id": "t1", "title": "T", "progress": 8})
        progress.save(self.db, {"id": "t1", "progress": 40})
        self.assertEqual(self._progress("t1"), 40)
        progress.save(self.db, {"id": "t1", "progress": 22})  # late, out-of-order save
        self.assertEqual(self._progress("t1"), 40)

    def _progress(self, tid):
        return self.db._conn.execute("SELECT progress FROM tasks WHERE id = ?", (tid,)).fetchone()[0]

    def test_completed_steps_are_saved_and_never_move_back(self):
        progress.save(self.db, {"id": "t1", "title": "T", "steps": steps("done", "active", "pending")})
        progress.save(self.db, {"id": "t1", "steps": steps("pending", "pending", "pending")})  # stale
        rows = self.db._conn.execute("SELECT step_key, state FROM task_steps WHERE task_id = 't1' ORDER BY seq").fetchall()
        self.assertEqual([tuple(r) for r in rows], [("understand", "done"), ("plan", "active"), ("execute", "pending")])
        progress.save(self.db, {"id": "t1", "steps": steps("done", "done", "active")})
        rows = self.db._conn.execute("SELECT state FROM task_steps WHERE task_id = 't1' ORDER BY seq").fetchall()
        self.assertEqual([r[0] for r in rows], ["done", "done", "active"])

    def test_finished_task_cannot_be_revived_by_a_late_save(self):
        progress.save(self.db, {"id": "t1", "title": "T", "status": "in_progress"})
        progress.save(self.db, {"id": "t1", "status": "completed", "progress": 100})
        res = progress.save(self.db, {"id": "t1", "status": "in_progress", "progress": 50})
        self.assertFalse(res["saved"])
        self.assertEqual(self.db.get_task("t1")["status"], "completed")

    def test_answered_questions_stay_answered(self):
        req = {"key": "r-folder", "kind": "info", "text": "Where is the folder?", "state": "answered", "answer": "D:\\Site"}
        progress.save(self.db, {"id": "t1", "title": "T", "requests": [req]})
        progress.save(self.db, {"id": "t1", "requests": [{**req, "state": "open", "answer": None}]})
        row = self.db._conn.execute("SELECT state, answer FROM task_requests").fetchone()
        self.assertEqual((row[0], row[1]), ("answered", "D:\\Site"))


class DuplicateTests(DbCase):
    def test_repeating_a_save_creates_no_duplicates(self):
        payload = {
            "id": "t1", "title": "T", "steps": steps("done", "active", "pending"),
            "requests": [{"key": "a-publish", "kind": "approval", "text": "Publish?", "state": "open"}],
            "context": [{"kind": "decision", "content": "Use the blue theme"}],
        }
        for _ in range(5):
            progress.save(self.db, payload)
        self.assertEqual([self.count(t) for t in ("tasks", "task_steps", "task_requests", "work_context")], [1, 3, 1, 1])

    def test_same_note_in_other_case_or_spacing_is_one_record(self):
        progress.save(self.db, {"id": "t1", "title": "T"})
        for text in ("Use the blue theme", "use  the BLUE theme ", "Use the blue\ntheme"):
            progress.add_context(self.db, "decision", text, "t1")
        self.assertEqual(self.count("work_context"), 1)
        progress.add_context(self.db, "instruction", "Use the blue theme", "t1")  # other kind = different record
        self.assertEqual(self.count("work_context"), 2)

    def test_project_wide_context_is_not_duplicated_either(self):
        for _ in range(3):
            progress.add_context(self.db, "project", "Shop website")
        self.assertEqual(self.count("work_context"), 1)

    def test_restoring_and_resuming_repeatedly_adds_nothing(self):
        progress.save(self.db, {"id": "t1", "title": "T", "status": "in_progress", "steps": steps("active", "pending", "pending")})
        before = [self.count(t) for t in ("tasks", "task_steps", "task_requests", "work_context")]
        for _ in range(3):
            progress.restore(self.db)
            progress.resume(self.db, "t1")
        self.assertEqual(before, [self.count(t) for t in ("tasks", "task_steps", "task_requests", "work_context")])


class RestoreTests(DbCase):
    def test_only_unfinished_tasks_are_restored_with_their_state(self):
        progress.save(self.db, {"id": "open", "title": "Open", "instruction": "do it", "status": "in_progress", "progress": 40,
                                "steps": steps("done", "active", "pending"), "activity": "Planning the work",
                                "context": [{"kind": "decision", "content": "Use blue"}, {"kind": "file", "content": "D:\\Site"}]})
        progress.save(self.db, {"id": "fin", "title": "Finished", "status": "completed", "progress": 100})
        progress.save(self.db, {"id": "stop", "title": "Stopped", "status": "cancelled"})
        res = progress.restore(self.db)
        self.assertEqual([t["task"]["id"] for t in res["tasks"]], ["open"])
        t = res["tasks"][0]
        self.assertEqual(t["task"]["progress"], 40)
        self.assertEqual(t["resume"]["stopped_at"]["key"], "plan")
        self.assertEqual(t["resume"]["decisions"], ["Use blue"])
        self.assertEqual({c["kind"] for c in t["context"]}, {"decision", "file"})
        self.assertIn("not saved", t["resume"]["summary"])

    def test_restore_is_read_only(self):
        progress.save(self.db, {"id": "t1", "title": "T", "status": "in_progress"})
        raw = lambda: self.db._conn.execute("SELECT status, updated_at, interrupted_at FROM tasks").fetchall()
        before = [tuple(r) for r in raw()]
        progress.restore(self.db)
        self.assertEqual(before, [tuple(r) for r in raw()])

    def test_resume_requires_fresh_approval_and_never_executes(self):
        approval = {"key": "a-publish", "kind": "approval", "text": "Publish the draft?", "state": "answered", "answer": "approved"}
        done = {"key": "a-send", "kind": "approval", "text": "Send the email?", "state": "answered", "answer": "approved", "executed": True}
        progress.save(self.db, {"id": "t1", "title": "T", "status": "in_progress", "requests": [approval, done]})
        info = progress.restore(self.db)["tasks"][0]["resume"]
        self.assertEqual([r["key"] for r in info["needs_reapproval"]], ["a-publish"])
        self.assertEqual(info["already_done"], ["Send the email?"])
        res = progress.resume(self.db, "t1")
        self.assertFalse(res["auto_executed"])
        self.assertEqual([r["req_key"] for r in res["reopened_approvals"]], ["a-publish"])
        states = {r["key"]: (r["state"], r["executed_at"] is not None) for r in progress.restore(self.db)["tasks"][0]["requests"]}
        self.assertEqual(states["a-publish"], ("open", False))  # must be approved again
        self.assertEqual(states["a-send"], ("answered", True))  # recorded as done: never offered again

    def test_resume_unknown_or_finished_task(self):
        with self.assertRaises(RequestError) as cm:
            progress.resume(self.db, "nope")
        self.assertEqual(cm.exception.code, NOT_FOUND)
        progress.save(self.db, {"id": "t1", "title": "T", "status": "completed"})
        with self.assertRaises(RequestError):
            progress.resume(self.db, "t1")

    def test_discard_keeps_the_record_but_removes_it_from_restore(self):
        progress.save(self.db, {"id": "t1", "title": "T", "status": "in_progress"})
        progress.discard(self.db, "t1")
        self.assertEqual(self.db.get_task("t1")["status"], "cancelled")
        self.assertEqual(progress.restore(self.db)["tasks"], [])


class AtomicityTests(DbCase):
    def test_a_failure_in_the_middle_of_a_save_keeps_the_previous_saved_state(self):
        progress.save(self.db, {"id": "t1", "title": "T", "status": "in_progress", "progress": 22, "steps": steps("done", "active", "pending")})
        original = self.db._new_id

        def boom():
            raise RuntimeError("simulated crash while saving")

        self.db._new_id = boom
        with self.assertRaises(RuntimeError):
            # task row and steps are written first; the context insert then blows up
            progress.save(self.db, {"id": "t1", "progress": 90, "steps": steps("done", "done", "done"), "context": [{"kind": "note", "content": "x"}]})
        self.db._new_id = original
        self.assertEqual(self._row("SELECT progress FROM tasks"), 22)
        self.assertEqual([r[0] for r in self.db._conn.execute("SELECT state FROM task_steps ORDER BY seq")], ["done", "active", "pending"])
        self.assertEqual(self.count("work_context"), 0)
        self.assertFalse(self.db._conn.in_transaction)

    def _row(self, sql):
        return self.db._conn.execute(sql).fetchone()[0]


class MigrationTests(unittest.TestCase):
    def test_v1_database_with_data_upgrades_without_losing_anything(self):
        with tempfile.TemporaryDirectory(prefix="fidex-mig-") as tmp:
            path = Path(tmp) / "fidex.sqlite"
            from app import database as dbmod
            conn = sqlite3.connect(str(path))
            for stmt in dbmod._SCHEMA_V1:
                conn.execute(stmt)
            conn.execute("PRAGMA user_version = 1")
            conn.execute("INSERT INTO tasks (id, title, description, status, created_at, updated_at) VALUES ('old', 'Old task', 'd', 'pending', 'x', 'x')")
            conn.commit()
            conn.close()
            with Database(path) as db:
                self.assertEqual(db.status()["schema_version"], dbmod.SCHEMA_VERSION)
                self.assertEqual(db.get_task("old")["title"], "Old task")
                self.assertEqual(progress.restore(db)["tasks"][0]["task"]["id"], "old")


class AppRestartTests(StorageServerCase):
    """The real backend process: close and reopen, and a hard crash."""

    def save(self, be, payload):
        return self.ok(be, "work.save", payload)

    def test_close_and_reopen_restores_unfinished_work(self):
        be = self.start()
        self.save(be, {"id": "t1", "title": "Build a site", "instruction": "Build a site", "status": "in_progress", "progress": 40,
                       "steps": steps("done", "active", "pending"), "activity": "Planning the work",
                       "requests": [{"key": "r-folder", "kind": "info", "text": "Where is the folder?", "state": "answered", "answer": "D:\\Site"}],
                       "context": [{"kind": "decision", "content": "Use the blue theme"}]})
        be.close()  # normal quit: stdin closes, backend shuts down cleanly

        be2 = self.start()
        res = self.ok(be2, "work.restore")
        self.assertIs(res["previous_session_ended_cleanly"], True)
        self.assertEqual(len(res["tasks"]), 1)
        t = res["tasks"][0]
        self.assertEqual((t["task"]["title"], t["task"]["progress"]), ("Build a site", 40))
        self.assertTrue(t["task"]["interrupted"])  # it was running when the app closed; it is not running now
        self.assertEqual(t["resume"]["stopped_at"]["key"], "plan")
        self.assertEqual(t["requests"][0]["answer"], "D:\\Site")
        self.assertEqual(t["resume"]["decisions"], ["Use the blue theme"])
        resumed = self.ok(be2, "work.resume", {"id": "t1"})
        self.assertFalse(resumed["auto_executed"])
        self.assertFalse(self.ok(be2, "work.restore")["tasks"][0]["task"]["interrupted"])

    def test_first_run_has_nothing_to_restore(self):
        res = self.ok(self.start(), "work.restore")
        self.assertEqual((res["tasks"], res["previous_session_ended_cleanly"]), ([], None))

    def test_backend_crash_keeps_everything_saved_before_the_crash(self):
        be = self.start()
        self.save(be, {"id": "t1", "title": "Plan launch", "status": "in_progress", "progress": 22, "steps": steps("done", "active", "pending")})
        self.save(be, {"id": "t1", "progress": 58, "steps": steps("done", "done", "active")})
        be.kill()  # no goodbye, like a crash

        be2 = self.start()
        res = self.ok(be2, "work.restore")
        self.assertIs(res["previous_session_ended_cleanly"], False)
        t = res["tasks"][0]
        self.assertEqual(t["task"]["progress"], 58)
        self.assertEqual(t["resume"]["stopped_at"]["key"], "execute")
        self.assertIn("closed unexpectedly", t["resume"]["summary"])
        self.assertIn("not saved", t["resume"]["summary"])  # honest about the unsaved tail
        self.assertEqual(self.ok(be2, "db.status")["recovered_from_damage"], False)

    def test_crash_during_the_backend_does_not_flag_the_next_clean_run(self):
        be = self.start()
        self.save(be, {"id": "t1", "title": "T", "status": "in_progress"})
        be.kill()
        be2 = self.start()
        self.ok(be2, "work.restore")
        be2.close()
        res = self.ok(self.start(), "work.restore")
        self.assertIs(res["previous_session_ended_cleanly"], True)

    def test_duplicate_saves_over_the_protocol(self):
        be = self.start()
        for _ in range(3):
            self.save(be, {"id": "t1", "title": "T", "status": "in_progress", "steps": steps("active", "pending", "pending"),
                           "context": [{"kind": "note", "content": "Keep it short"}]})
        self.assertEqual(self.ok(be, "db.status")["counts"]["tasks"], 1)
        t = self.ok(be, "work.restore")["tasks"][0]
        self.assertEqual((len(t["steps"]), len(t["context"])), (3, 1))

    def test_bad_requests_are_rejected_with_stable_codes(self):
        be = self.start()
        self.fails(be, "work.save", {"title": "no id"}, "INVALID_PAYLOAD")
        self.fails(be, "work.save", {"id": "t1", "title": "T", "progress": 101}, "INVALID_PAYLOAD")
        self.fails(be, "work.resume", {"id": "missing"}, "NOT_FOUND")
        self.fails(be, "work.context.add", {"kind": "bogus", "content": "x"}, "INVALID_PAYLOAD")
        self.fails(be, "work.restore", {"x": 1}, "INVALID_PAYLOAD")


if __name__ == "__main__":
    unittest.main()
