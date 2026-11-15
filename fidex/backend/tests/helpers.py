"""Shared helpers: start the real backend as a subprocess and talk to it over its pipes."""
import json
import os
import pathlib
import subprocess
import sys
import threading

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


class BackendProcess:
    """The real `python -u -m app.main`, exactly as Electron starts it."""

    def __init__(self, test_mode=True, data_dir=None):
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        # Never let a developer's real FIDEX_DATA_DIR leak into a test run.
        env.pop("FIDEX_DATA_DIR", None)
        if data_dir is not None:
            env["FIDEX_DATA_DIR"] = str(data_dir)
        if test_mode:
            env["FIDEX_BACKEND_TEST"] = "1"
        else:
            env.pop("FIDEX_BACKEND_TEST", None)
        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "app.main"],
            cwd=str(BACKEND_DIR),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self.stderr_lines = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self.ready = self.read()  # the startup handshake

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self.stderr_lines.append(line.decode("utf-8", "replace").rstrip())

    def send_raw(self, data: bytes):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send(self, message: dict):
        self.send_raw(json.dumps(message).encode("utf-8") + b"\n")

    def read(self):
        line = self.proc.stdout.readline()
        if not line:
            raise EOFError("backend closed its output")
        return json.loads(line.decode("ascii"))  # protocol lines must be pure ASCII JSON

    def request(self, request_id, request_type, payload=None):
        message = {"id": request_id, "type": request_type}
        if payload is not None:
            message["payload"] = payload
        self.send(message)
        return self.read()

    def kill(self):
        """End the process abruptly (no goodbye), like a crash or Task Manager."""
        self.proc.kill()
        self.proc.wait()
        self.close()

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except OSError:
                pass
