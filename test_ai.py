"""AI brain tests. A tiny fake Ollama server stands in for the real one (no model is needed)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import ai
from app.handlers import HANDLERS
from app.protocol import RequestError

SEEN = []


class FakeOllama(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"models": [{"name": "qwen3:4b"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(body)
        if body["model"] == "missing:1b":
            return self._send(404, {"error": "model 'missing:1b' not found"})
        self._send(200, {"model": body["model"], "message": {"role": "assistant", "content": "<think>hmm</think>Hello there!"}})


@pytest.fixture()
def fake(monkeypatch):
    server = HTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("FIDEX_OLLAMA_HOST", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.delenv("FIDEX_OLLAMA_MODEL", raising=False)
    SEEN.clear()
    yield server
    server.shutdown()


def test_reply_uses_qwen3_and_sends_memory(fake):
    history = [
        {"role": "user", "content": "My dog is called Rex."},
        {"role": "assistant", "content": "Nice name!"},
        {"role": "user", "content": "What is my dog called?"},
    ]
    out = HANDLERS["chat.reply"]({"messages": history, "profile": "Full name: Ada"})
    assert out["text"] == "Hello there!"  # hidden reasoning stripped
    sent = SEEN[-1]
    assert sent["model"] == "qwen3:4b" and sent["stream"] is False
    assert [m["role"] for m in sent["messages"]] == ["system", "user", "assistant", "user"]
    assert "Rex" in sent["messages"][1]["content"] and "Ada" in sent["messages"][0]["content"]


def test_missing_model(fake, monkeypatch):
    monkeypatch.setenv("FIDEX_OLLAMA_MODEL", "missing:1b")
    with pytest.raises(RequestError) as e:
        HANDLERS["chat.reply"]({"messages": [{"role": "user", "content": "hi"}]})
    assert e.value.code == ai.AI_MODEL_MISSING


def test_ollama_not_running(monkeypatch):
    monkeypatch.setenv("FIDEX_OLLAMA_HOST", "http://127.0.0.1:9")
    with pytest.raises(RequestError) as e:
        HANDLERS["chat.reply"]({"messages": [{"role": "user", "content": "hi"}]})
    assert e.value.code == ai.AI_UNAVAILABLE


def test_validation():
    for bad in ({}, {"messages": []}, {"messages": [{"role": "assistant", "content": "x"}]}, {"messages": [{"role": "user", "content": "x"}], "bogus": 1}):
        with pytest.raises(RequestError):
            HANDLERS["chat.reply"](bad)


def test_status(fake):
    s = HANDLERS["ai.status"]({})
    assert s["reachable"] and s["model_installed"] and s["model"] == "qwen3:4b"


def test_history_budget():
    long = [{"role": "user" if i % 2 == 0 else "assistant", "content": "x" * 3000} for i in range(30)] + [{"role": "user", "content": "now"}]
    msgs = ai.build_messages(long)
    assert msgs[0]["role"] == "system" and msgs[1]["role"] == "user" and msgs[-1]["content"] == "now"
    assert sum(len(m["content"]) for m in msgs[1:]) <= ai.MAX_HISTORY_CHARS + ai.MAX_OLD_CHARS + 3000
