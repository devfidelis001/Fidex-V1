"""Tests against the real backend process, talking over its stdin/stdout like Electron does."""
import json
import threading
import time
import unittest

from helpers import BackendProcess


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.be = BackendProcess()
        self.addCleanup(self.be.close)

    # ---- startup ----
    def test_ready_handshake(self):
        self.assertEqual(self.be.ready["event"], "ready")
        self.assertEqual(self.be.ready["data"]["protocol"], 1)
        self.assertEqual(self.be.ready["data"]["backend_version"], "0.8.0")

    # ---- the Step 4 communication test ----
    def test_hello_round_trip(self):
        res = self.be.request("a1", "hello", {"message": "Hello from FIDEX AI"})
        self.assertEqual(res["id"], "a1")
        self.assertTrue(res["ok"])
        self.assertEqual(res["type"], "hello")
        self.assertEqual(res["data"]["reply"], "Python backend received: Hello from FIDEX AI")
        self.assertIs(res["data"]["brain_connected"], False)

    def test_unicode_survives_the_round_trip(self):
        text = "café ✓ \U0001f680 中文"
        res = self.be.request("u", "hello", {"message": text})
        self.assertEqual(res["data"]["received"], text)

    def test_integer_ids_are_echoed(self):
        self.assertEqual(self.be.request(42, "ping")["id"], 42)

    # ---- invalid requests never kill the backend ----
    def test_invalid_requests_are_answered_and_backend_survives(self):
        cases = [
            (b"this is not json\n", None, "INVALID_JSON"),
            (b"[1,2,3]\n", None, "INVALID_REQUEST"),
            (b'{"type":"ping"}\n', None, "INVALID_REQUEST"),
            (b'{"id":"x","type":"Not Valid"}\n', "x", "INVALID_REQUEST"),
            (b'{"id":"y","type":"ping","payload":[1]}\n', "y", "INVALID_REQUEST"),
            (b'{"id":"z","type":"does.not.exist"}\n', "z", "UNKNOWN_TYPE"),
            (b'{"id":"h","type":"hello","payload":{"message":5}}\n', "h", "INVALID_PAYLOAD"),
            (b'{"id":"\xff"}\n', None, "INVALID_JSON"),
        ]
        for raw, expected_id, code in cases:
            self.be.send_raw(raw)
            res = self.be.read()
            self.assertFalse(res["ok"], raw)
            self.assertEqual(res["error"]["code"], code, raw)
            self.assertEqual(res["id"], expected_id, raw)
        self.assertTrue(self.be.request("alive", "ping")["ok"])
        self.assertIsNone(self.be.proc.poll())

    def test_blank_lines_are_ignored(self):
        self.be.send_raw(b"\n\n   \n")
        self.assertTrue(self.be.request("1", "ping")["ok"])

    def test_oversized_request_is_rejected_and_stream_recovers(self):
        self.be.send_raw(b'{"id":"big","type":"hello","payload":{"message":"' + b"a" * (2 * 1024 * 1024) + b'"}}\n')
        res = self.be.read()
        self.assertEqual(res["error"]["code"], "REQUEST_TOO_LARGE")
        self.assertTrue(self.be.request("after", "ping")["ok"])

    # ---- robustness ----
    def test_handler_exception_is_contained(self):
        res = self.be.request("boom", "debug.raise")
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"]["code"], "HANDLER_ERROR")
        self.assertNotIn("deliberate", json.dumps(res))  # no internals leak to the interface
        self.assertTrue(self.be.request("after", "ping")["ok"])

    def test_stray_print_does_not_corrupt_protocol(self):
        res = self.be.request("p", "debug.print")
        self.assertTrue(res["ok"])
        self.assertTrue(self.be.request("q", "ping")["ok"])
        deadline = time.time() + 2
        while time.time() < deadline and not any("stray text" in l for l in self.be.stderr_lines):
            time.sleep(0.02)
        self.assertTrue(any("stray text" in l for l in self.be.stderr_lines), "stray print should land on stderr")

    def test_large_unicode_response(self):
        res = self.be.request("b", "debug.big", {"size": 300000})
        self.assertEqual(len(res["data"]["text"]), 300000)
        self.assertEqual(res["data"]["unicode"], "café ✓ \U0001f680")

    def test_slow_request_does_not_block_others(self):
        self.be.send({"id": "slow", "type": "debug.sleep", "payload": {"seconds": 1.0}})
        started = time.time()
        fast = self.be.request("fast", "ping")
        self.assertTrue(fast["ok"])
        self.assertLess(time.time() - started, 0.8, "ping must answer while the slow request is still running")
        slow = self.be.read()
        self.assertEqual(slow["id"], "slow")

    def test_many_concurrent_requests(self):
        for i in range(8):
            self.be.send({"id": f"c{i}", "type": "debug.sleep", "payload": {"seconds": 0.2}})
        answers = {self.be.read()["id"] for _ in range(8)}
        self.assertEqual(answers, {f"c{i}" for i in range(8)})

    def test_back_to_back_requests_from_one_client_are_never_told_busy(self):
        """Regression (found in Step 5): the slot used to be freed AFTER the reply was sent, so a
        client with only one request outstanding got BACKEND_BUSY from its 9th request on."""
        for kind, payload in (("ping", None), ("no.such.type", None), ("hello", {"message": 5})):
            for i in range(120):
                res = self.be.request(f"{kind}-{i}", kind, payload)
                if not res["ok"]:
                    self.assertNotEqual(res["error"]["code"], "BACKEND_BUSY", f"{kind} request #{i + 1}")

    def test_too_many_in_flight_gets_busy_not_a_hang(self):
        for i in range(12):
            self.be.send({"id": f"s{i}", "type": "debug.sleep", "payload": {"seconds": 0.5}})
        results = [self.be.read() for _ in range(12)]
        busy = [r for r in results if not r["ok"]]
        self.assertTrue(busy)
        self.assertTrue(all(r["error"]["code"] == "BACKEND_BUSY" for r in busy))

    # ---- shutdown ----
    def test_shutdown_request_exits_cleanly(self):
        res = self.be.request("bye", "shutdown")
        self.assertTrue(res["ok"])
        self.assertEqual(self.be.proc.wait(timeout=5), 0)

    def test_closing_stdin_exits_cleanly(self):
        self.be.proc.stdin.close()
        self.assertEqual(self.be.proc.wait(timeout=5), 0)

    def test_shutdown_waits_for_running_request(self):
        self.be.send({"id": "work", "type": "debug.sleep", "payload": {"seconds": 0.5}})
        self.be.send({"id": "bye", "type": "shutdown"})
        ids = [self.be.read()["id"], self.be.read()["id"]]
        self.assertEqual(ids, ["work", "bye"])
        self.assertEqual(self.be.proc.wait(timeout=5), 0)


class ProductionModeTests(unittest.TestCase):
    def test_debug_handlers_unavailable_without_test_flag(self):
        be = BackendProcess(test_mode=False)
        self.addCleanup(be.close)
        res = be.request("1", "debug.crash")
        self.assertEqual(res["error"]["code"], "UNKNOWN_TYPE")
        self.assertIsNone(be.proc.poll())


if __name__ == "__main__":
    unittest.main()
