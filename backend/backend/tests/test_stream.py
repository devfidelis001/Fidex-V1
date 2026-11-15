"""Streaming: tokens arrive in pieces, reasoning stays private, memory follows the mode, tokens go out as events."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import ai, handlers, memory
from app.handlers import HANDLERS

SEEN = []
GATE = None  # set by a test: the fake Ollama pauses after its first chunk until this event is set
GATE_SEEN = []
CHUNKS = [{"message": {"content": "<thi"}}, {"message": {"content": "nk>secret plan</think>Hel"}}, {"message": {"thinking": "hidden"}},
          {"message": {"content": "lo "}}, {"message": {"content": "world"}}, {"done": True, "model": "qwen3.5:4b", "eval_count": 3}]


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(body)
        self.send_response(200)
        self.end_headers()
        for i, c in enumerate(CHUNKS):
            self.wfile.write((json.dumps(c) + "\n").encode())
            self.wfile.flush()
            if GATE is not None and i == 0:
                GATE_SEEN.append(GATE.wait(3))  # held until the first token has reached the UI event stream


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
    CHUNKS = [{"message": {"content": "Okay, private plan. "}}, {"message": {"content": "more private</think>The answer."}}, {"done": True, "model": "qwen3.5:4b"}]
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


def test_first_token_reaches_the_ui_before_ollama_has_finished(monkeypatch):
    global GATE, CHUNKS
    GATE, saved = threading.Event(), CHUNKS
    CHUNKS = [{"message": {"content": "Hello "}}, {"message": {"content": "world"}}, {"done": True, "model": "qwen3.5:4b"}]
    GATE_SEEN.clear()
    try:
        def emit(name, data):
            if name == "chat.token":
                GATE.set()  # the UI got its first token while Ollama is still mid-answer
        monkeypatch.setattr(handlers, "EMIT", emit)
        out = HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "hi"}], "stream_id": "g"})
    finally:
        GATE, CHUNKS = None, saved
    assert GATE_SEEN == [True]  # False would mean tokens were buffered until the end
    assert out["text"] == "Hello world" and out["timings"]["first_token_ms"] is not None


def test_prompt_asks_for_short_direct_answers_and_disables_qwen_thinking(monkeypatch):
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "what is a kite?"}]})
    sysmsg = SEEN[-1]["messages"][0]["content"]
    assert "at most 2 short sentences" in sysmsg and "no tips" in sysmsg and "no background or history" in sysmsg
    assert SEEN[-1]["model"] == "qwen3.5:4b" and SEEN[-1]["think"] is False
    assert ai.NO_THINK not in sysmsg  # qwen3.5 has no /no_think text switch; think=false does the job
    monkeypatch.setenv("FIDEX_OLLAMA_MODEL", "qwen3:4b")
    HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "plan"}], "mode": "guide"})
    assert SEEN[-1]["messages"][0]["content"].rstrip().endswith(ai.NO_THINK)  # older qwen3 keeps the text switch, agent modes too


def test_thinking_only_when_explicitly_requested():
    ask = {"messages": [{"role": "user", "content": "why is the sky blue?"}]}
    HANDLERS["chat.stream"](ask)
    assert SEEN[-1]["think"] is False and SEEN[-1]["options"]["num_predict"] == ai.NUM_PREDICT
    out = HANDLERS["chat.stream"]({**ask, "think": True})
    assert SEEN[-1]["think"] is True and SEEN[-1]["options"]["num_predict"] == ai.NUM_PREDICT_THINK
    assert ai.NO_THINK not in SEEN[-1]["messages"][0]["content"]
    assert out["text"] == "Hello world" and out["timings"]["thinking"] is True  # reasoning is still never shown
    with pytest.raises(Exception):
        HANDLERS["chat.stream"]({**ask, "think": "yes"})


def test_stop_cancels_generation_at_once_and_allows_a_new_message():
    import time
    global GATE, CHUNKS
    saved, GATE = CHUNKS, threading.Event()  # the fake Ollama pauses after the first chunk
    CHUNKS = [{"message": {"content": "Hello "}}, {"message": {"content": "world"}}, {"done": True, "model": "qwen3.5:4b"}]
    result, first_token, old_emit = {}, threading.Event(), handlers.EMIT
    handlers.EMIT = lambda name, data: first_token.set() if name == "chat.token" else None
    def run():
        try:
            result.update(HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "long one"}], "stream_id": "s1"}))
        except Exception as err:  # noqa: BLE001
            result["error"] = repr(err)

    t = threading.Thread(target=run)
    try:
        t.start()
        assert first_token.wait(3)  # first token reached the UI; the model is "still generating"
        started = time.time()
        assert HANDLERS["chat.cancel"]({"stream_id": "s1"}) == {"cancelled": True}
        t.join(2)
        assert not t.is_alive() and time.time() - started < 1.5  # returned right away, not after GATE's 3 s wait
        assert result.get("cancelled") is True and result["text"] == "Hello" and result["memory_saved"] == 0, result
    finally:
        handlers.EMIT = old_emit
        GATE.set()
        GATE, CHUNKS = None, saved
        GATE_SEEN.clear()
    out = HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "next question"}], "stream_id": "s2"})  # generation lock was released
    assert out["text"] == "Hello world" and not out.get("cancelled")
    assert ai._streams == {}


def test_stop_before_generation_starts_and_validation():
    HANDLERS["chat.cancel"]({"stream_id": "early"})
    out = HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "hi"}], "stream_id": "early"})
    assert out["cancelled"] is True and out["text"] == ""
    for bad in ({}, {"stream_id": ""}, {"stream_id": "x", "bogus": 1}):
        with pytest.raises(Exception):
            HANDLERS["chat.cancel"](bad)


class Silent(BaseHTTPRequestHandler):
    """A model that accepted the request but sends nothing (still loading / reading the prompt)."""
    release = threading.Event()

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        Silent.release.wait(10)


@pytest.mark.parametrize("socket_shutdown_works", [True, False])
def test_stop_works_while_the_model_has_sent_nothing_even_if_closing_the_socket_does_nothing(monkeypatch, socket_shutdown_works):
    import time
    if not socket_shutdown_works:  # some platforms do not wake a blocked read when the socket is closed from another thread
        monkeypatch.setattr(ai, "_kill_resp", lambda resp: None)
    Silent.release.clear()
    silent = HTTPServer(("127.0.0.1", 0), Silent)
    threading.Thread(target=silent.serve_forever, daemon=True).start()
    monkeypatch.setenv("FIDEX_OLLAMA_HOST", f"http://127.0.0.1:{silent.server_port}")
    monkeypatch.delenv("FIDEX_OLLAMA_TIMEOUT", raising=False)  # no response timeout
    result = {}
    t = threading.Thread(target=lambda: result.update(HANDLERS["chat.stream"]({"messages": [{"role": "user", "content": "hello"}], "stream_id": "hang1"})))
    try:
        t.start()
        time.sleep(0.4)  # the request is out, nothing has come back, the generation thread is waiting
        assert t.is_alive()
        started = time.time()
        HANDLERS["chat.cancel"]({"stream_id": "hang1"})
        t.join(2)
        assert not t.is_alive() and time.time() - started < 1.0  # the generation thread exited promptly
        assert result.get("cancelled") is True and result["text"] == ""
        assert not ai._gen_lock.locked()  # a new message can start at once
    finally:
        Silent.release.set()
        silent.shutdown()
