"""Autopilot: works on a project for up to 9 hours with no permission questions. It sets today's goal, picks the next small task,
hands it to Take Over, records the result, and repeats. The plan is saved on disk, so tomorrow it continues from where it stopped."""
from __future__ import annotations

import datetime as dt
import json
import time
from pathlib import Path

from . import ai, fs_actions

DAY_SECONDS = 9 * 3600
FILE = Path.home() / ".fidex" / "autopilot.json"
PLAN_PROMPT = (
    "You are the project manager of an autonomous Windows agent. The agent can ONLY: open system apps, run cmd commands, create or edit files and folders in the project, type and click. "
    "Never delete anything. Reply with EXACTLY ONE line and nothing else.\n"
    "If asked for the GOAL: the single most important thing to finish today for this project (one short sentence).\n"
    "If asked for the TASK: the next small concrete instruction for the agent, written like a user command that names the real folder and file "
    "(example: add a footer with the shop name to index.html in my folder shop). Do not repeat a task already done. If the goal is fully achieved reply exactly: GOAL_DONE"
)


def _load() -> dict:
    try:
        return json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(st: dict) -> None:
    FILE.parent.mkdir(exist_ok=True)
    FILE.write_text(json.dumps(st, indent=1), encoding="utf-8")


def _ask(prompt: str) -> str:
    from . import hands  # noqa: PLC0415

    text = hands._ask_qwen([{"role": "system", "content": PLAN_PROMPT}, {"role": "user", "content": prompt}], None, 120, hands.PLANNER_MODEL)
    return (ai.clean_reply(text) or "").strip().splitlines()[0].strip(" `\"*-") if (text or "").strip() else ""


def _files(folder: str) -> str:
    try:
        return ", ".join(sorted(f.name for f in Path(folder).iterdir() if not f.name.startswith("."))[:25]) or "(empty)"
    except OSError:
        return "(unreadable)"


def start(instruction: str, project: str | None = None, goal: str | None = None) -> dict:
    """Begins or resumes. A new day keeps the project and the unfinished work and picks a new goal."""
    st = _load()
    today = dt.date.today().isoformat()
    low = instruction.lower()
    for base in ("desktop", "documents", "downloads"):  # the project named in the sentence wins over the saved one
        try:
            for d in fs_actions.known_folder(base).iterdir():
                if not project and d.is_dir() and not d.name.startswith(".") and len(d.name) >= 3 and d.name.lower() in low:
                    project = str(d)
        except OSError:
            pass
    if project and project != st.get("project"):
        st.update(project=project, goal="", history=[], done_today=[], blocked=[])
    if project:
        st["project"] = project
    elif not st.get("project") and fs_actions.LAST_PROJECT[0]:
        st["project"] = str(fs_actions.LAST_PROJECT[0])
    if not st.get("project"):
        return {"ok": False, "say": "Which project folder should I work on? Say, for example: start working on my folder shop."}
    new_day = st.get("day") != today
    if new_day:
        st.update(day=today, spent=0, done_today=[], goal="")
    if goal:
        st["goal"] = goal
    if not st.get("goal"):
        yesterday = "; ".join(st.get("history", [])[-6:]) or "nothing yet"
        st["goal"] = _ask(f"GOAL for project folder {st['project']} (contains: {_files(st['project'])}). Recently done: {yesterday}. User request: {instruction[:300]}") or f"Move the project {Path(st['project']).name} forward"
    st["began"] = time.time()
    st["blocked"] = st.get("blocked", [])
    _save(st)
    return {"ok": True, "goal": st["goal"], "project": st["project"], "resumed": bool(st.get("history")) and not goal, "left_seconds": max(0, DAY_SECONDS - st.get("spent", 0))}


def next_task() -> dict:
    st = _load()
    spent = st.get("spent", 0) + (time.time() - st.get("began", time.time()))
    if spent >= DAY_SECONDS:
        st["spent"] = spent
        st["history"] = st.get("history", []) + [f"{st['day']}: 9 hours used. Goal '{st['goal']}'; done: {len(st.get('done_today', []))} tasks"]
        _save(st)
        return {"task": None, "reason": "9 hours of work are used. Tomorrow I continue from here."}
    done = st.get("done_today", [])
    task = _ask(f"TASK for goal '{st['goal']}' in folder {st['project']} (contains now: {_files(st['project'])}). Already done today: {'; '.join(done[-8:]) or 'nothing'}. Failed/blocked, do not retry: {'; '.join(st.get('blocked', [])[-5:]) or 'none'}.")
    if not task or task.upper().startswith("GOAL_DONE"):
        newgoal = _ask(f"GOAL for project folder {st['project']} (contains: {_files(st['project'])}). Just finished: {st['goal']}. Done today: {'; '.join(done[-6:])}")
        st.setdefault("history", []).append(f"{st['day']}: finished '{st['goal']}'")
        if not newgoal or newgoal == st["goal"]:
            _save(st)
            return {"task": None, "reason": f"Goal achieved: {st['goal']}"}
        st["goal"] = newgoal
        _save(st)
        return {"task": None, "new_goal": newgoal, "retry": True}
    st["current"] = task
    _save(st)
    return {"task": task[:300], "goal": st["goal"]}


def report(ok: bool) -> dict:
    st = _load()
    task = st.pop("current", "")
    if task:
        (st.setdefault("done_today", []) if ok else st.setdefault("blocked", [])).append(task)
        st.setdefault("log", []).append({"t": dt.datetime.now().isoformat(timespec="seconds"), "task": task, "ok": ok})
        del st["log"][:-200]
    st["spent"] = st.get("spent", 0) + (time.time() - st.get("began", time.time()))
    st["began"] = time.time()
    _save(st)
    return {"saved": True}
