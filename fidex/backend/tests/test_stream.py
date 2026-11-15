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


def test_untagged_reasoning_before_closing_tag_is_dropped():
    # qwen3 with thinking on: the opening <think> is in the prompt, so the output has only a closing tag
    f = ai._ThinkFilter(inside=True)
    out = "".join(f.feed(c) for c in ["Okay, the user says hi. I should ", "reply.</thi", "nk>\n\nHello!"]) + f.flush()
    assert out.strip() == "Hello!"


def test_leaked_reasoning_never_reaches_final_answer(monkeypatch):
    global CHUNKS
    saved = CHUNKS
    CHUNKS = [{"message": {"content": "Okay, private plan. "}}, {"message": {"content": "more private</think>The answer."}}, {"done": True, "model": "qwen3:4b"}]
    try:
        events = []
        monkeypatch.setattr(handlers, "EMIT", lambda n, d: events.append((n, d)))
        out = HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "why is the sky blue and how does it work"}], "stream_id": "s2"})
    finally:
        CHUNKS = saved
    assert SEEN[-1]["think"] is False  # even a "complex" question is sent with think=false
    assert out["text"] == "The answer."
    # With think=false nothing is held back (the first token streams at once), so only the saved final answer is guaranteed clean.
    assert "private" not in out["text"] and "private" not in "".join(SEEN[0]["messages"][0]["content"])


def test_stream_sends_pieces_and_hides_reasoning(monkeypatch):
    events = []
    monkeypatch.setattr(handlers, "EMIT", lambda n, d: events.append((n, d)))
    out = HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "hi"}], "stream_id": "s1"})
    assert out["text"] == "Hello world"
    assert SEEN[0]["stream"] is True
    toks = [d["text"] for n, d in events if n == "chat.token" and d["stream_id"] == "s1"]
    assert len(toks) >= 2 and "".join(toks) == "Hello world"
    assert "secret" not in "".join(toks) and "hidden" not in "".join(toks)
    assert len(SEEN) == 1 and SEEN[0]["think"] is False  # one Ollama call, no extra FIDEX MIND call
    assert not any(n == "chat.stage" for n, d in events)
    assert events[0][0] == "chat.token"  # the first thing streamed is the real answer


def test_normal_chat_makes_exactly_one_ollama_call_with_think_false(monkeypatch):
    for mode in ("chat", "takeover", "guide"):
        SEEN.clear()
        HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "explain why the sky is blue"}], "mode": mode})
        assert len(SEEN) == 1 and SEEN[0]["think"] is False and SEEN[0]["stream"] is True


def test_agent_modes_use_full_memory_and_no_thinking():  # Take Over / Guide Me keep full-memory access
    memory.upsert("identity", "name", "Name: Ada", "user")
    memory.upsert("preference", "chess", "User likes chess", "user")
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "chess plan"}], "mode": "chat"})
    assert "chess" not in SEEN[-1]["messages"][0]["content"]
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "chess plan"}], "mode": "takeover"})
    sysmsg = SEEN[-1]["messages"][0]["content"]
    assert "chess" in sysmsg and "Take Over" in sysmsg and SEEN[-1]["think"] is False
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "chess plan"}], "mode": "guide"})
    assert "Guide Me" in SEEN[-1]["messages"][0]["content"]
