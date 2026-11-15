"""Streaming: tokens arrive in pieces, reasoning stays private, memory follows the mode, tokens go out as events."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import ai, handlers, memory
from app.handlers import HANDLERS

SEEN = []
CHUNKS = [{"message": {"content": "<thi"}}, {"message": {"content": "nk>secret plan</think>Hel"}}, {"message": {"thinking": "hidden"}},
          {"message": {"content": "lo "}}, {"message": {"content": "world"}}, {"done": True, "model": "qwen3:4b", "eval_count": 3}]


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(body)
        self.send_response(200)
        self.end_headers()
        for c in CHUNKS:
            self.wfile.write((json.dumps(c) + "\n").encode())
            self.wfile.flush()


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FIDEX_DB_PATH", str(tmp_path / "s.db"))
    server = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("FIDEX_OLLAMA_HOST", f"http://127.0.0.1:{server.server_port}")
    SEEN.clear()
    yield
    server.shutdown()


def test_think_filter_handles_split_tags():
    f = ai._ThinkFilter()
    out = "".join(f.feed(c) for c in ["a<th", "ink>x", "y</thi", "nk>b"]) + f.flush()
    assert out == "ab"


def test_stream_sends_pieces_and_hides_reasoning(monkeypatch):
    events = []
    monkeypatch.setattr(handlers, "EMIT", lambda n, d: events.append((n, d)))
    out = HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "hi"}], "stream_id": "s1"})
    assert out["text"] == "Hello world"
    assert SEEN[0]["stream"] is True
    toks = [d["text"] for n, d in events if n == "chat.token" and d["stream_id"] == "s1"]
    assert len(toks) >= 2 and "".join(toks) == "Hello world"
    assert "secret" not in "".join(toks) and "hidden" not in "".join(toks)
    stages = [d["text"] for n, d in events if n == "chat.stage" and d["stream_id"] == "s1"]
    assert stages[0] == "Reading your message" and "Writing the answer" in stages and stages[-1].startswith("Finished in")
    assert all("secret" not in t and "hidden" not in t for t in stages)  # progress lines never carry reasoning
    order = [n for n, d in events]
    assert order.index("chat.stage") < order.index("chat.token")


def test_agent_modes_use_full_memory_and_no_thinking():
    memory.upsert("identity", "name", "Name: Ada", "user")
    memory.upsert("preference", "chess", "User likes chess", "user")
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "chess plan"}], "mode": "chat"})
    assert "chess" not in SEEN[-1]["messages"][0]["content"]
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "chess plan"}], "mode": "takeover"})
    sysmsg = SEEN[-1]["messages"][0]["content"]
    assert "chess" in sysmsg and "Take Over" in sysmsg and SEEN[-1]["think"] is False
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "chess plan"}], "mode": "guide"})
    assert "Guide Me" in SEEN[-1]["messages"][0]["content"]
