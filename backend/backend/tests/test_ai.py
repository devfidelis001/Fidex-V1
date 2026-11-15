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
        self._send(200, {"models": [{"name": "qwen3.5:4b"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(body)
        if body["model"] == "missing:1b":
            return self._send(404, {"error": "model 'missing:1b' not found"})
        self._send(200, {"model": body["model"], "message": {"role": "assistant", "content": "<think>hmm</think>Hello there!"}, "load_duration": 2_000_000_000, "prompt_eval_duration": 1_000_000_000, "eval_duration": 3_000_000_000, "total_duration": 6_000_000_000, "prompt_eval_count": 50, "eval_count": 10})


@pytest.fixture(autouse=True)
def _db(tmp_path, monkeypatch):
    monkeypatch.setenv("FIDEX_DB_PATH", str(tmp_path / "test.db"))


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
    assert sent["model"] == "qwen3.5:4b" and sent["stream"] is False
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
    assert s["reachable"] and s["model_installed"] and s["model"] == "qwen3.5:4b"


def test_history_budget():
    long = [{"role": "user" if i % 2 == 0 else "assistant", "content": "x" * 3000} for i in range(30)] + [{"role": "user", "content": "now"}]
    msgs = ai.build_messages(long)
    assert msgs[0]["role"] == "system" and msgs[1]["role"] == "user" and msgs[-1]["content"] == "now"
    assert sum(len(m["content"]) for m in msgs[1:]) <= ai.MAX_HISTORY_CHARS + ai.MAX_OLD_CHARS + 3000


def test_chat_reply_defaults_to_no_think_and_supports_explicit_think(fake):
    msg = [{"role": "user", "content": "hi"}]
    HANDLERS["chat.reply"]({"messages": msg})
    assert SEEN[-1]["think"] is False and SEEN[-1]["model"] == "qwen3.5:4b"
    HANDLERS["chat.reply"]({"messages": msg, "think": True})
    assert SEEN[-1]["think"] is True
    with pytest.raises(RequestError):
        HANDLERS["chat.reply"]({"messages": msg, "think": "yes"})


def test_no_response_timeout_by_default(monkeypatch):
    monkeypatch.delenv("FIDEX_OLLAMA_TIMEOUT", raising=False)
    assert ai._timeout() is None  # a long answer is never cut off by a timer
    monkeypatch.setenv("FIDEX_OLLAMA_TIMEOUT", "0")
    assert ai._timeout() is None
    monkeypatch.setenv("FIDEX_OLLAMA_TIMEOUT", "45")
    assert ai._timeout() == 45.0  # an explicit limit is still honoured


# ---------- on-demand past-conversation memory ----------
def _system_of(body):
    return body["messages"][0]["content"]


def test_past_chats_are_added_only_when_sent(fake):
    hist = [{"role": "user", "content": "What did we decide about the logo?"}]
    HANDLERS["chat.reply"]({"messages": hist, "past_chats": 'Chat "Logo ideas" (3 Nov 2026):\nUser: which logo?\nFIDEX AI: the kite icon'})
    system = _system_of(SEEN[-1])
    assert "Earlier conversations:" in system and "the kite icon" in system
    assert "do not invent" in system.lower()

    HANDLERS["chat.reply"]({"messages": [{"role": "user", "content": "Hello"}]})  # ordinary message: no past chats
    assert "Earlier conversations" not in _system_of(SEEN[-1])


def test_past_chats_are_capped_and_validated(fake):
    HANDLERS["chat.reply"]({"messages": [{"role": "user", "content": "what did we say earlier?"}], "past_chats": "z" * 10000})
    assert _system_of(SEEN[-1]).count("z") == ai.MAX_PAST_CHARS
    with pytest.raises(RequestError):
        HANDLERS["chat.reply"]({"messages": [{"role": "user", "content": "hi"}], "past_chats": 5})
    with pytest.raises(RequestError):
        HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "hi"}], "past_chats": ["x"], "stream_id": "s1"})


def test_build_messages_past_chats_keeps_conversation_context():
    msgs = ai.build_messages([{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}, {"role": "user", "content": "continue"}], past_chats="Chat X: hello")
    assert "Chat X: hello" in msgs[0]["content"]
    assert [m["content"] for m in msgs[1:]] == ["a", "b", "continue"]
    assert "Earlier conversations" not in ai.build_messages([{"role": "user", "content": "hi"}])[0]["content"]
