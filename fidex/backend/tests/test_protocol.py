import unittest

from helpers import BACKEND_DIR  # noqa: F401  (sets sys.path)
from app import protocol
from app.protocol import RequestError, parse_request


def parse(text):
    return parse_request(text.encode("utf-8") if isinstance(text, str) else text)


class ParseRequestTests(unittest.TestCase):
    def test_valid_request(self):
        self.assertEqual(parse('{"id":"1","type":"hello","payload":{"message":"hi"}}'), ("1", "hello", {"message": "hi"}))

    def test_integer_id_and_dotted_type_and_missing_payload(self):
        self.assertEqual(parse('{"id":7,"type":"backend.info"}'), (7, "backend.info", {}))

    def test_null_payload_becomes_empty(self):
        self.assertEqual(parse('{"id":"1","type":"ping","payload":null}')[2], {})

    def assertRejects(self, text, code):
        with self.assertRaises(RequestError) as ctx:
            parse(text)
        self.assertEqual(ctx.exception.code, code, text)

    def test_not_json(self):
        self.assertRejects("not json at all", protocol.INVALID_JSON)

    def test_empty(self):
        self.assertRejects("   ", protocol.INVALID_JSON)

    def test_invalid_utf8(self):
        self.assertRejects(b'{"id":"1","type":"\xff\xfe"}', protocol.INVALID_JSON)

    def test_not_an_object(self):
        for text in ("[1,2]", '"hello"', "42", "null", "true"):
            self.assertRejects(text, protocol.INVALID_REQUEST)

    def test_bad_ids(self):
        for text in (
            '{"type":"ping"}',
            '{"id":"","type":"ping"}',
            '{"id":null,"type":"ping"}',
            '{"id":true,"type":"ping"}',
            '{"id":1.5,"type":"ping"}',
            '{"id":["a"],"type":"ping"}',
            '{"id":"%s","type":"ping"}' % ("x" * 129),
        ):
            self.assertRejects(text, protocol.INVALID_REQUEST)

    def test_bad_types(self):
        for t in ('""', "null", "5", '"Hello"', '"he llo"', '"1abc"', '"a..b"', '".a"', '"a."', '"a-b"', '"%s"' % ("a" * 65), '"h\\u00e9llo"'):
            self.assertRejects('{"id":"1","type":%s}' % t, protocol.INVALID_REQUEST)

    def test_payload_must_be_object(self):
        for p in ('"text"', "[1]", "5", "true"):
            self.assertRejects('{"id":"1","type":"ping","payload":%s}' % p, protocol.INVALID_REQUEST)

    def test_error_carries_id_when_known(self):
        with self.assertRaises(RequestError) as ctx:
            parse('{"id":"abc","type":"Bad Type"}')
        self.assertEqual(ctx.exception.request_id, "abc")

    def test_deeply_nested_json_is_rejected_not_crashed(self):
        with self.assertRaises(RequestError):
            parse("[" * 100000)


class EncodeTests(unittest.TestCase):
    def test_encoded_line_is_ascii_json_with_newline(self):
        data = protocol.encode(protocol.ok_response("1", "hello", {"text": "café ✓ \U0001f680"}))
        self.assertTrue(data.endswith(b"\n"))
        self.assertEqual(data.count(b"\n"), 1)
        data.decode("ascii")  # must not raise

    def test_response_shapes(self):
        self.assertEqual(protocol.ok_response("1", "t", {"a": 1}), {"id": "1", "ok": True, "type": "t", "data": {"a": 1}})
        err = protocol.error_response("1", "t", "CODE", "msg")
        self.assertEqual(err, {"id": "1", "ok": False, "type": "t", "error": {"code": "CODE", "message": "msg"}})
        self.assertIsNone(protocol.error_response(None, None, "C", "m")["type"])


if __name__ == "__main__":
    unittest.main()
