"""Permanent memory tests + the FIDEX -> (fake) Ollama flow: retrieval, persistence, no full-profile resend."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import ai, memory
from app.handlers import HANDLERS
from app.protocol import RequestError

SEEN = []


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        SEEN.append(body)
        data = json.dumps({"model": body["model"], "message": {"role": "assistant", "content": "ok"}, "eval_count": 3}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FIDEX_DB_PATH", str(tmp_path / "m.db"))
    server = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("FIDEX_OLLAMA_HOST", f"http://127.0.0.1:{server.server_port}")
    SEEN.clear()
    yield
    server.shutdown()


def chat(text, profile=None, mode=None):
    payload = {"messages": [{"role": "user", "content": text}]}
    if mode is not None:
        payload["mode"] = mode
    if profile is not None:
        payload["profile"] = profile
    return HANDLERS["chat.reply"](payload)


def system_prompt():
    return SEEN[-1]["messages"][0]["content"]


def test_only_relevant_memories_are_sent():
    profile = "Full name: Ada Obi\nCompany: Zenith Labs\nHobbies: chess and painting\nSkills: python\nLocation: Lagos\nGoals: launch the FIDEX app"
    chat("what is the capital of France", profile)
    sp = system_prompt()
    assert "Ada Obi" in sp  # name is always known
    assert "Zenith" not in sp and "chess" not in sp and "painting" not in sp  # rest of the profile is NOT resent
    chat("any good chess openings for me", profile)
    assert "chess" not in system_prompt()  # Normal Chat: name + main project only
    chat("any good chess openings for me", profile, "takeover")
    assert "chess" in system_prompt() and "Zenith" not in system_prompt()  # Take Over: relevant full memory


def test_normal_chat_has_name_and_main_project_only_and_modes_are_validated():
    memory.upsert("identity", "name", "Name: Ada Obi", "user")
    memory.upsert("project", "fidex", "Working on FIDEX AI", "user")
    memory.upsert("preference", "likes-chess", "User likes chess", "user")
    text = memory.relevant("chess openings")
    assert "Ada Obi" in text and "FIDEX AI" in text and "chess" not in text
    for mode in ("takeover", "guide"):
        assert "chess" in memory.relevant("chess openings", mode)
        assert "chess" in HANDLERS["agent.context"]({"query": "chess openings", "mode": mode})["text"]
    with pytest.raises(RequestError):
        HANDLERS["agent.context"]({"query": "x", "mode": "chat"})
    with pytest.raises(RequestError):
        chat("hi", None, "bogus")


def test_persists_across_restart_and_profile_sync_is_skipped_when_unchanged():
    chat("hi", "Full name: Ada Obi\nCompany: Zenith Labs")
    memory._ready.clear()  # simulates a fresh process: only the file remains
    assert {m["content"] for m in memory.list_all()} >= {"Full name: Ada Obi", "Company: Zenith Labs"}
    assert memory.sync_profile("Full name: Ada Obi\nCompany: Zenith Labs") == {"changed": False}


def test_learns_updates_and_ignores_small_talk():
    chat("My name is Tunde Bello and I live in Abuja.")
    chat("what's the weather like?")
    chat("how are you today")
    chat("I live in Lagos now.")
    items = {(m["category"], m["key"]): m["content"] for m in memory.list_all()}
    assert items[("identity", "name")] == "Name: Tunde Bello"
    assert items[("profile", "location")] == "Lives in Lagos now"  # updated, not duplicated
    assert len(items) == 2


def test_review_edit_delete():
    m = HANDLERS["memory.add"]({"category": "fact", "content": "Prefers dark mode"})
    assert HANDLERS["memory.update"]({"id": m["id"], "content": "Prefers light mode"})["content"] == "Prefers light mode"
    assert any(x["id"] == m["id"] for x in HANDLERS["memory.list"]({})["memories"])
    HANDLERS["memory.delete"]({"id": m["id"]})
    assert not HANDLERS["memory.list"]({})["memories"]
    with pytest.raises(Exception):
        HANDLERS["memory.delete"]({"id": m["id"]})


def test_edited_memory_survives_profile_resync():
    memory.sync_profile("Company: Zenith Labs")
    mid = memory.list_all()[0]["id"]
    memory.update(mid, "Company: Zenith Labs Ltd")
    memory.sync_profile("Company: Zenith Labs\nSkills: python")
    assert "Company: Zenith Labs Ltd" in [m["content"] for m in memory.list_all()]


def test_thinking_is_never_used_and_timings_returned():
    out = chat("hi there")
    assert SEEN[-1]["think"] is False and SEEN[-1]["options"]["num_ctx"] == ai.NUM_CTX
    assert "total_ms" in out["timings"] and out["timings"]["thinking"] is False
    chat("explain why the sky is blue and compare it step by step with a sunset")  # used to trigger reasoning
    assert SEEN[-1]["think"] is False and SEEN[-1]["options"]["num_predict"] == ai.NUM_PREDICT


def test_duplicate_identical_requests_share_one_generation():
    a = []
    ts = [threading.Thread(target=lambda: a.append(chat("hello twice"))) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(a) == 2 and len(SEEN) <= 2  # never more than the two sends; usually one


def test_warmup_uses_same_context_size():
    assert HANDLERS["ai.warmup"]({})["loaded"] is True
    assert SEEN[-1]["options"]["num_ctx"] == ai.NUM_CTX and SEEN[-1]["messages"] == []
