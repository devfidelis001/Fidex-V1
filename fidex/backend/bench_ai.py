"""Measure FIDEX AI response times against the real Ollama. Run from the backend folder:

    python bench_ai.py                # legacy settings vs optimized, same question, 3 runs each
    python bench_ai.py --cold         # unload the model first so the first run includes model loading
    python bench_ai.py --question "..." --runs 5

"legacy" = the settings FIDEX used before (num_ctx 8192, 40-message/12000-char history, 4000-char profile,
no reply cap). "optimized" = what FIDEX sends now, built by the real ai.build_messages/memory code.
All times come from Ollama's own counters (milliseconds). Nothing here is estimated.
"""
import argparse
import json
import os
import statistics
import tempfile
import time
import urllib.request

os.environ.setdefault("FIDEX_DB_PATH", os.path.join(tempfile.mkdtemp(), "bench.db"))
from app import ai, memory  # noqa: E402

OLD_SYSTEM = (
    "You are FIDEX AI, a personal AI agent that lives on the user's Windows computer. You are helpful, clear and direct. "
    "Answer in the language the user writes in. Keep answers focused; use short paragraphs or simple lists when they help. "
    "Use plain text (no markdown tables or heavy formatting) because the chat shows text only. "
    "If you do not know something, say so instead of guessing. Remember everything said earlier in this conversation and use it."
)
PROFILE = "\n".join(f"{k}: {v}" for k, v in [("Full name", "Ada Obi"), ("Company", "Zenith Labs"), ("Role", "Founder"), ("Skills", "python, electron, ai"), ("Goals", "launch FIDEX AI"), ("Location", "Lagos")] * 4)
HISTORY = [{"role": "user" if i % 2 == 0 else "assistant", "content": ("Earlier message about my projects and plans. " * 7)[:300]} for i in range(20)]


def post(body):
    req = urllib.request.Request(ai.host() + "/api/chat", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t = time.monotonic()
    with urllib.request.urlopen(req, timeout=400) as r:
        res = json.loads(r.read())
    res["_wall"] = time.monotonic() - t
    return res


def row(res):
    ms = lambda k: round((res.get(k) or 0) / 1e6)  # noqa: E731
    return dict(load=ms("load_duration"), prompt=ms("prompt_eval_duration"), gen=ms("eval_duration"), total=round(res["_wall"] * 1000), ptok=res.get("prompt_eval_count"), rtok=res.get("eval_count"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--question", default="Give me two quick ideas for a name for my new app.")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--cold", action="store_true")
    a = ap.parse_args()
    q = {"role": "user", "content": a.question}
    memory.sync_profile(PROFILE)
    legacy = {"model": ai.model(), "stream": False, "think": False, "keep_alive": "30m", "options": {"num_ctx": 8192, "temperature": 0.7},
              "messages": [{"role": "system", "content": OLD_SYSTEM + "\n\nWhat the user has told you about themselves (use it when relevant):\n" + PROFILE}] + HISTORY + [q]}
    new = {"model": ai.model(), "stream": False, "think": False, "keep_alive": ai.KEEP_ALIVE,
           "options": {"num_ctx": ai.NUM_CTX, "num_predict": ai.NUM_PREDICT, "temperature": 0.5, "top_k": 20, "top_p": 0.85, "repeat_penalty": 1.05},
           "messages": ai.build_messages(HISTORY + [q], memory.relevant(a.question))}
    for label, body in (("legacy", legacy), ("optimized", new)):
        if a.cold:
            post({"model": body["model"], "messages": [], "keep_alive": 0})
        rows = []
        for i in range(a.runs):
            rows.append(row(post(body)))
            print(f"{label:9} run {i + 1}: " + "  ".join(f"{k}={v}" for k, v in rows[-1].items()), flush=True)
        print(f"{label:9} median total = {statistics.median(r['total'] for r in rows)} ms   (load/prompt/gen/total in ms)\n")
    print(f"prompt size legacy={len(json.dumps(legacy['messages']))} chars, optimized={len(json.dumps(new['messages']))} chars")


if __name__ == "__main__":
    main()
