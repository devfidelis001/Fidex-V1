"""Message format shared by Electron (JavaScript) and the Python backend.

Transport: UTF-8 text, ONE JSON object per line ("newline-delimited JSON") on stdin/stdout.
stdout is reserved for protocol messages. Anything human-readable goes to stderr (logging).

Request  (JS -> Python):  {"id": "1", "type": "hello", "payload": {"message": "..."}}
Success  (Python -> JS):  {"id": "1", "ok": true,  "type": "hello", "data": {...}}
Failure  (Python -> JS):  {"id": "1", "ok": false, "type": "hello", "error": {"code": "...", "message": "..."}}
Event    (Python -> JS):  {"event": "ready", "data": {...}}   (no id: not a reply to anything)
"""
from __future__ import annotations

import json
from typing import Any

# Largest accepted request line, in bytes. Protects the backend from runaway messages.
MAX_LINE_BYTES = 1024 * 1024
MAX_ID_LENGTH = 128
MAX_TYPE_LENGTH = 64

# Error codes (stable strings that JavaScript can rely on)
INVALID_JSON = "INVALID_JSON"
INVALID_REQUEST = "INVALID_REQUEST"
INVALID_PAYLOAD = "INVALID_PAYLOAD"
REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE"
UNKNOWN_TYPE = "UNKNOWN_TYPE"
HANDLER_ERROR = "HANDLER_ERROR"
BACKEND_BUSY = "BACKEND_BUSY"
BACKEND_STOPPING = "BACKEND_STOPPING"
# Local storage (Step 5)
NOT_FOUND = "NOT_FOUND"  # a valid id that matches no record
DUPLICATE_ID = "DUPLICATE_ID"  # a record with that id already exists
DB_UNAVAILABLE = "DB_UNAVAILABLE"  # the database could not be opened / is not configured
DB_ERROR = "DB_ERROR"  # SQLite reported a problem while running an operation


class RequestError(Exception):
    """Raised by handlers (and the parser) for an expected, reportable failure."""

    def __init__(self, code: str, message: str, request_id: Any = None, request_type: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.request_id = request_id
        self.request_type = request_type


def _valid_type_name(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > MAX_TYPE_LENGTH:
        return False
    parts = value.split(".")
    for part in parts:
        if not part or not part[0].isascii() or not part[0].islower():
            return False
        if not all(c.isascii() and (c.islower() or c.isdigit() or c == "_") for c in part):
            return False
    return True


def parse_request(raw: bytes) -> tuple[Any, str, dict]:
    """Turn one received line into (id, type, payload). Raises RequestError if it is invalid."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise RequestError(INVALID_JSON, "Request is not valid UTF-8 text.") from None
    text = text.strip()
    if not text:
        raise RequestError(INVALID_JSON, "Empty request.")
    try:
        message = json.loads(text)
    except (ValueError, RecursionError):
        raise RequestError(INVALID_JSON, "Request is not valid JSON.") from None
    if not isinstance(message, dict):
        raise RequestError(INVALID_REQUEST, "Request must be a JSON object.")

    request_id = message.get("id")
    id_ok = (isinstance(request_id, str) and 0 < len(request_id) <= MAX_ID_LENGTH) or (
        isinstance(request_id, int) and not isinstance(request_id, bool)
    )
    if not id_ok:
        raise RequestError(INVALID_REQUEST, "Request needs an 'id' (non-empty string or integer).")

    request_type = message.get("type")
    if not _valid_type_name(request_type):
        raise RequestError(INVALID_REQUEST, "Request needs a valid 'type' (for example 'hello').", request_id)

    payload = message.get("payload", {})
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise RequestError(INVALID_REQUEST, "'payload' must be a JSON object.", request_id, request_type)
    return request_id, request_type, payload


def ok_response(request_id: Any, request_type: str, data: Any) -> dict:
    return {"id": request_id, "ok": True, "type": request_type, "data": data}


def error_response(request_id: Any, request_type: Any, code: str, message: str) -> dict:
    return {
        "id": request_id,
        "ok": False,
        "type": request_type if isinstance(request_type, str) else None,
        "error": {"code": code, "message": message},
    }


def event_message(name: str, data: Any) -> dict:
    return {"event": name, "data": data}


def encode(message: dict) -> bytes:
    """One line of pure ASCII JSON (non-ASCII is \\u-escaped), so no console encoding can corrupt it."""
    return (json.dumps(message, ensure_ascii=True, separators=(",", ":"), default=str) + "\n").encode("ascii")
