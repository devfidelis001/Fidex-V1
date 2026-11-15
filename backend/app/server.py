"""The request loop: read lines from stdin, run handlers, write replies to stdout.

- Every request runs on its own daemon thread, so a slow handler never blocks the others
  (and never blocks Electron, which does not wait for Python at all).
- Writes to stdout are serialised with a lock so reply lines never interleave.
- End of input (Electron closed the pipe or died) shuts the backend down cleanly.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import BinaryIO

from . import PROTOCOL_VERSION, __version__
from . import handlers as handler_module
from .protocol import (
    BACKEND_BUSY,
    BACKEND_STOPPING,
    HANDLER_ERROR,
    MAX_LINE_BYTES,
    REQUEST_TOO_LARGE,
    UNKNOWN_TYPE,
    RequestError,
    encode,
    error_response,
    event_message,
    ok_response,
    parse_request,
)

log = logging.getLogger("fidex.backend")

MAX_IN_FLIGHT = 8
SHUTDOWN_DRAIN_SECONDS = 2.0


class Server:
    def __init__(self, stdin: BinaryIO, stdout: BinaryIO):
        self._stdin = stdin
        self._stdout = stdout
        self._write_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)
        self._threads: set[threading.Thread] = set()
        self._threads_lock = threading.Lock()
        self._stopping = False
        handler_module.EMIT = lambda name, data: self._send(event_message(name, data))

    # ----- output -----
    def _send(self, message: dict) -> bool:
        try:
            data = encode(message)
            with self._write_lock:
                self._stdout.write(data)
                self._stdout.flush()
            return True
        except (BrokenPipeError, OSError, ValueError):
            # Electron is gone; there is nobody left to answer.
            self._stopping = True
            return False

    # ----- input -----
    def _read_line(self):
        """Return one line (bytes), b'' at end of input, or the string 'TOO_LARGE'."""
        line = self._stdin.readline(MAX_LINE_BYTES + 1)
        if line and len(line) > MAX_LINE_BYTES and not line.endswith(b"\n"):
            # Throw away the rest of this oversized line without holding it in memory.
            while True:
                chunk = self._stdin.readline(MAX_LINE_BYTES)
                if not chunk or chunk.endswith(b"\n"):
                    break
            return "TOO_LARGE"
        return line

    # ----- handling -----
    def _run_handler(self, request_id, request_type, payload):
        started = time.perf_counter()
        response = error_response(request_id, request_type, HANDLER_ERROR, "The backend failed while handling this request.")
        outcome = None  # what to log once the reply is on its way
        try:
            try:
                func = handler_module.HANDLERS.get(request_type)
                if func is None:
                    raise RequestError(UNKNOWN_TYPE, f"No handler for request type '{request_type}'.")
                data = func(payload)
                response = ok_response(request_id, request_type, data)
                outcome = (log.info, "request ok    id=%s type=%s %.1fms", (request_id, request_type, (time.perf_counter() - started) * 1000))
            except RequestError as err:
                response = error_response(request_id, request_type, err.code, err.message)
                outcome = (log.warning, "request error id=%s type=%s code=%s", (request_id, request_type, err.code))
            except Exception:  # a bug in a handler must never take the backend down
                log.exception("handler crashed id=%s type=%s", request_id, request_type)
        finally:
            # Free the slot BEFORE the reply is sent. A client that has just received its answer
            # may send the next request at once; if the slot were still held, a client that only
            # ever has one request outstanding could be told BACKEND_BUSY (it was, from the 9th
            # back-to-back request on). The thread stays registered until the reply is written, so
            # shutdown still waits for it.
            self._slots.release()
        try:
            self._send(response)
            if outcome is not None:
                outcome[0](outcome[1], *outcome[2])
        finally:
            with self._threads_lock:
                self._threads.discard(threading.current_thread())

    def _dispatch(self, request_id, request_type, payload):
        if not self._slots.acquire(blocking=False):
            self._send(error_response(request_id, request_type, BACKEND_BUSY, "Too many requests are running. Try again shortly."))
            log.warning("request error id=%s type=%s code=%s", request_id, request_type, BACKEND_BUSY)
            return
        thread = threading.Thread(target=self._run_handler, args=(request_id, request_type, payload), daemon=True)
        with self._threads_lock:
            self._threads.add(thread)
        thread.start()

    def _drain(self):
        deadline = time.monotonic() + SHUTDOWN_DRAIN_SECONDS
        while True:
            with self._threads_lock:
                running = [t for t in self._threads if t.is_alive()]
            if not running or time.monotonic() >= deadline:
                if running:
                    log.warning("shutting down with %d request(s) still running", len(running))
                return
            running[0].join(timeout=max(0.0, min(0.05, deadline - time.monotonic())))

    # ----- main loop -----
    def serve(self) -> int:
        self._send(
            event_message(
                "ready",
                {"protocol": PROTOCOL_VERSION, "backend_version": __version__, "pid": _pid(), "python": _py()},
            )
        )
        log.info("backend ready (protocol %s)", PROTOCOL_VERSION)

        while not self._stopping:
            line = self._read_line()
            if line == b"":
                log.info("input closed; shutting down")
                break
            if line == "TOO_LARGE":
                self._send(error_response(None, None, REQUEST_TOO_LARGE, f"Request is larger than {MAX_LINE_BYTES} bytes."))
                log.warning("request error code=%s", REQUEST_TOO_LARGE)
                continue
            if not line.strip():
                continue  # blank line: ignore

            try:
                request_id, request_type, payload = parse_request(line)
            except RequestError as err:
                self._send(error_response(err.request_id, err.request_type, err.code, err.message))
                log.warning("request error id=%s code=%s", err.request_id, err.code)
                continue

            if request_type == "shutdown":
                self._stopping = True
                self._drain()
                self._send(ok_response(request_id, "shutdown", {"stopping": True}))
                log.info("shutdown requested; bye")
                break

            self._dispatch(request_id, request_type, payload)

        self._stopping = True
        self._drain()
        return 0


def _pid() -> int:
    import os

    return os.getpid()


def _py() -> str:
    import platform

    return platform.python_version()
