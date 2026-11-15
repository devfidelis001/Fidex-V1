import unittest

from helpers import BACKEND_DIR  # noqa: F401
from app import handlers
from app.protocol import INVALID_PAYLOAD, RequestError


class HandlerTests(unittest.TestCase):
    def test_ping(self):
        self.assertTrue(handlers.HANDLERS["ping"]({})["pong"])

    def test_hello_replies_and_does_not_claim_a_brain(self):
        out = handlers.HANDLERS["hello"]({"message": "Hello from FIDEX AI"})
        self.assertEqual(out["reply"], "Python backend received: Hello from FIDEX AI")
        self.assertEqual(out["received"], "Hello from FIDEX AI")
        self.assertIs(out["brain_connected"], False)
        self.assertIn("not connected", out["note"])

    def test_hello_keeps_unicode(self):
        out = handlers.HANDLERS["hello"]({"message": "Olá ✓ \U0001f680"})
        self.assertIn("\U0001f680", out["reply"])

    def test_hello_rejects_bad_payloads(self):
        for payload in ({}, {"message": ""}, {"message": "   "}, {"message": 5}, {"message": None}, {"message": ["x"]}, {"message": "x" * 2001}):
            with self.assertRaises(RequestError) as ctx:
                handlers.HANDLERS["hello"](payload)
            self.assertEqual(ctx.exception.code, INVALID_PAYLOAD)

    def test_backend_info(self):
        info = handlers.HANDLERS["backend.info"]({})
        self.assertEqual(info["protocol"], 1)
        self.assertIn("hello", info["handlers"])
        self.assertFalse([h for h in info["handlers"] if h.startswith("debug.")])

    def test_debug_handlers_are_off_by_default(self):
        import os

        if os.environ.get("FIDEX_BACKEND_TEST") != "1":
            self.assertNotIn("debug.crash", handlers.HANDLERS)


if __name__ == "__main__":
    unittest.main()
