"""Windows Hands: real mouse/keyboard control for Take Over, using PyAutoGUI.

Flow (nothing here is simulated):
  hands.start   -> new Take Over session (clears Stop, history, pending actions)
  hands.plan    -> Qwen picks ONE supported action for the instruction (or just answers). The action is
                   validated against the real screen size and registered as pending with an id.
  hands.approve -> the user's decision for that pending action.
  hands.execute -> runs the pending action with PyAutoGUI. Refused unless approved (when approval is required).
                   Returns the real result (or the real error), which is also fed back to Qwen on the next plan.
  hands.stop    -> stops the planner and any running action at once and blocks further execution until hands.start.

PyAutoGUI is imported lazily, so the backend still starts on a machine without a display.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid

from . import ai, brain, fast_plan, fs_actions, vision
from .protocol import INVALID_PAYLOAD, RequestError

log = logging.getLogger("fidex.hands")

HANDS_UNAVAILABLE = "HANDS_UNAVAILABLE"  # PyAutoGUI missing or no screen to control
HANDS_STOPPED = "HANDS_STOPPED"  # the user pressed Stop (or the PyAutoGUI corner fail-safe fired)
APPROVAL_REQUIRED = "APPROVAL_REQUIRED"  # the action was not approved by the user
ACTION_INVALID = "ACTION_INVALID"  # the action is not supported or its values are not valid
ACTION_FAILED = "ACTION_FAILED"  # PyAutoGUI / the OS reported an error while executing
STEP_LIMIT = "STEP_LIMIT"
VERIFY_FAILED = "VERIFY_FAILED"  # the action ran but its real effect could not be confirmed: it is a FAILURE, never a success

MAX_STEPS = 12  # actions per instruction; protects against a runaway loop
MAX_TEXT = 500
MAX_PASTE = 6000  # a paste (clipboard + Ctrl+V) is instant, so a whole prompt fits in one action
MAX_HISTORY = 20
TYPE_CHUNK = 20  # characters typed between two Stop checks
TYPE_INTERVAL = 0.01
MAX_WAIT = 10.0
MAX_SCROLL = 5000
APP_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,59}$")

ACTIONS = ("click", "click_on", "move", "scroll", "type", "press", "hotkey", "open_app", "wait", "paste") + fs_actions.FS_ACTIONS  # the file actions are only accepted from the fast recipe planner (allow_fs)
MAX_PLAN_STEPS = 25  # steps in one up-front plan
UNLOAD_AFTER_PLAN = False  # brain stays loaded: every unload makes the next task pay a full model reload (set True to free RAM after planning)
UNLOAD_DELAY = 600.0  # seconds of no planning before the model is unloaded. It was 90s, so a task started two minutes later paid a full model reload
OPEN_ALIASES = {"whatsapp": "whatsapp:", "visual studio code": "code", "vs code": "code", "vscode": "code", "google chrome": "chrome", "calculator": "calc", "command prompt": "cmd", "microsoft edge": "msedge", "edge": "msedge", "task manager": "taskmgr", "paint": "mspaint", "file explorer": "explorer"}
# Everything that changes something on the computer needs the user's approval. Only these never do.
NO_APPROVAL = ("move", "scroll", "wait")

SYSTEM_PROMPT = (
    "You control the user's Windows mouse and keyboard, one action at a time. Screen {w}x{h} (x 0-{wm}, y 0-{hm}), centre ({cx},{cy}). "
    "You cannot see the screen: use coordinates the user gave or places computable from the screen size (centre, corners, edges, percentages); otherwise use the keyboard or open_app. "
    "You really do control them: never refuse and never offer code.\n"
    "Actions: "
    '{{"type":"open_app","name":"notepad"}} | {{"type":"type","text":"hi"}} (ASCII) | {{"type":"press","key":"enter"}} | {{"type":"hotkey","keys":["ctrl","s"]}} | '
    '{{"type":"click","x":100,"y":200,"button":"left","clicks":1}} | {{"type":"move","x":100,"y":200}} | {{"type":"scroll","amount":-300}} (negative = down) | {{"type":"wait","seconds":1}}\n'
    'Reply with ONE JSON object only, no markdown: {{"action":<one action or null>,"done":<true if this action finishes the instruction>,"say":"<only when action is null: short reason>"}}. '
    "Earlier results are listed below; never claim success unless a result says ok."
)


def _pg():
    """Returns the pyautogui module, configured. Raises HANDS_UNAVAILABLE when it cannot be used here."""
    try:
        import pyautogui  # noqa: PLC0415
    except ImportError:
        raise RequestError(HANDS_UNAVAILABLE, "PyAutoGUI is not installed. Run: pip install -r requirements.txt") from None
    except Exception as err:  # noqa: BLE001  (no display, missing Tk/X, ...)
        raise RequestError(HANDS_UNAVAILABLE, f"PyAutoGUI cannot start here: {err}") from None
    pyautogui.FAILSAFE = True  # slam the mouse into a screen corner to abort
    pyautogui.PAUSE = 0.01  # faster between actions
    pyautogui.MINIMUM_SLEEP = 0.01  # more steps per glide, so the pointer travels smoothly instead of in a few jumps
    return pyautogui


TIMINGS: dict[str, dict] = {}  # per-subsystem real timings: name -> {n, total_ms, last_ms}


def timed(name: str, started: float) -> float:
    ms = (time.monotonic() - started) * 1000
    t = TIMINGS.setdefault(name, {"n": 0, "total_ms": 0.0, "last_ms": 0.0})
    t["n"] += 1
    t["total_ms"] += ms
    t["last_ms"] = ms
    log.info("timing %s %.0f ms", name, ms)
    return ms


def metrics() -> dict:
    return {k: {"n": v["n"], "avg_ms": round(v["total_ms"] / v["n"]), "last_ms": round(v["last_ms"])} for k, v in TIMINGS.items()}


def screen_size() -> tuple[int, int]:
    pg = _pg()
    try:
        size = pg.size()
        w, h = int(size[0]), int(size[1])
    except Exception as err:  # noqa: BLE001
        raise RequestError(HANDS_UNAVAILABLE, f"Cannot read the screen size: {err}") from None
    if w <= 0 or h <= 0:
        raise RequestError(HANDS_UNAVAILABLE, "The screen size is not available.")
    return w, h


# ---------- validation ----------
def _int(value, name: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or abs(value) == float("inf"):
        raise RequestError(ACTION_INVALID, f"'{name}' must be a number.")
    value = int(round(value))
    if not lo <= value <= hi:
        raise RequestError(ACTION_INVALID, f"'{name}' must be between {lo} and {hi} (got {value}).")
    return value


def _key(name, valid) -> str:
    if not isinstance(name, str) or not name.strip():
        raise RequestError(ACTION_INVALID, "A key name is required.")
    key = name.strip().lower()
    aliases = {"control": "ctrl", "return": "enter", "escape": "esc", "windows": "win", "del": "delete", "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right"}
    key = aliases.get(key, key)
    if key not in valid:
        raise RequestError(ACTION_INVALID, f"'{name}' is not a key PyAutoGUI supports.")
    return key


def normalize_action(raw, size: tuple[int, int], valid_keys, allow_fs: bool = False) -> dict:
    """Checks one action against the supported list and the real screen size. Returns a clean copy."""
    if not isinstance(raw, dict) or raw.get("type") not in ACTIONS:
        raise RequestError(ACTION_INVALID, f"Unsupported action. Supported: {', '.join(ACTIONS)}.")
    kind, w, h = raw["type"], size[0], size[1]
    if kind == "paste":  # only from trusted planners (allow_fs): used to hand a prepared prompt to another AI
        text = raw.get("text")
        if not allow_fs or not isinstance(text, str) or not text.strip() or len(text) > MAX_PASTE:
            raise RequestError(ACTION_INVALID, f"'paste' needs text of at most {MAX_PASTE} characters and is not available to a model-written plan.")
        return {"type": "paste", "text": text}
    if kind in fs_actions.FS_ACTIONS:
        if not allow_fs:
            raise RequestError(ACTION_INVALID, f"'{kind}' is not available to a model-written plan.")
        return fs_actions.normalize(raw)
    if kind == "click_on":  # the EYE (Live Vision) finds the target on the live screen when the step runs
        target = raw.get("target")
        if not isinstance(target, str) or not 2 <= len(target.strip()) <= 120:
            raise RequestError(ACTION_INVALID, "'target' must be 2 to 120 characters describing what to click.")
        button = raw.get("button", "left")
        if button not in ("left", "right", "middle"):
            raise RequestError(ACTION_INVALID, "'button' must be left, right or middle.")
        return {"type": kind, "target": target.strip(), "button": button, "clicks": _int(raw.get("clicks", 1), "clicks", 1, 3)}
    if kind in ("click", "move"):
        act = {"type": kind, "x": _int(raw.get("x"), "x", 0, w - 1), "y": _int(raw.get("y"), "y", 0, h - 1)}
        if kind == "click":
            button = raw.get("button", "left")
            if button not in ("left", "right", "middle"):
                raise RequestError(ACTION_INVALID, "'button' must be left, right or middle.")
            act.update(button=button, clicks=_int(raw.get("clicks", 1), "clicks", 1, 3))
        return act
    if kind == "scroll":
        return {"type": kind, "amount": _int(raw.get("amount"), "amount", -MAX_SCROLL, MAX_SCROLL)}
    if kind == "type":
        text = raw.get("text")
        if not isinstance(text, str) or not text:
            raise RequestError(ACTION_INVALID, "'text' must be non-empty text.")
        if len(text) > MAX_TEXT:
            raise RequestError(ACTION_INVALID, f"'text' is longer than {MAX_TEXT} characters.")
        bad = sorted({c for c in text if not (c.isascii() and (c.isprintable() or c in "\n\t"))})
        if bad:
            raise RequestError(ACTION_INVALID, "PyAutoGUI can only type plain ASCII text; unsupported characters: " + "".join(bad[:10]))
        return {"type": kind, "text": text}
    if kind == "press":
        key = raw.get("key")
        if isinstance(key, str) and "+" in key and len(key) > 1:  # "ctrl+s" given as a single key
            return normalize_action({"type": "hotkey", "keys": key.split("+")}, size, valid_keys)
        return {"type": kind, "key": _key(key, valid_keys)}
    if kind == "hotkey":
        keys = raw.get("keys")
        if not isinstance(keys, list) or not 2 <= len(keys) <= 4:
            raise RequestError(ACTION_INVALID, "'keys' must be a list of 2 to 4 keys.")
        return {"type": kind, "keys": [_key(k, valid_keys) for k in keys]}
    if kind == "open_app":
        name = raw.get("name")
        if not isinstance(name, str) or not APP_NAME_RE.match(name.strip()):
            raise RequestError(ACTION_INVALID, "'name' must be a plain application name such as notepad, calc or chrome.")
        name = name.strip()
        return {"type": kind, "name": OPEN_ALIASES.get(name.lower(), name)}
    seconds = raw.get("seconds", 1)
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 0 <= seconds <= MAX_WAIT:
        raise RequestError(ACTION_INVALID, f"'seconds' must be a number from 0 to {MAX_WAIT:g}.")
    return {"type": "wait", "seconds": float(seconds)}


AUTO_APPROVE = True  # the user agrees by giving the instruction: tools run immediately, no Approve question. Set False to bring the question back.


def requires_approval(action: dict) -> bool:
    return (not AUTO_APPROVE) and action["type"] not in NO_APPROVAL


def describe(action: dict) -> str:
    k = action["type"]
    if k in fs_actions.FS_ACTIONS:
        return fs_actions.describe(action)
    if k == "click":
        return f"{action['button']}-click{' x' + str(action['clicks']) if action['clicks'] > 1 else ''} at ({action['x']}, {action['y']})"
    if k == "click_on":
        return f"click on {action['target']} (found on the live screen)"
    if k == "move":
        return f"move the mouse to ({action['x']}, {action['y']})"
    if k == "scroll":
        return f"scroll {action['amount']}"
    if k == "type":
        t = action["text"]
        return "type " + json.dumps(t if len(t) <= 80 else t[:77] + "...")
    if k == "paste":
        return f"paste a {len(action['text'])}-character prompt"
    if k == "press":
        return f"press {action['key']}"
    if k == "hotkey":
        return "press " + "+".join(action["keys"])
    if k == "open_app":
        return f"open {action['name']}"
    return f"wait {action['seconds']:g}s"


# ---------- session ----------
class Session:
    def __init__(self):
        self.lock = threading.RLock()
        self.exec_lock = threading.Lock()  # one real action at a time
        self.stopped = threading.Event()
        self.paused = threading.Event()  # Pause Actions: execute() holds every action while this is set (planning is not affected)
        self.history: list[dict] = []
        self.pending: dict[str, dict] = {}
        self.goals: list[str] = []
        self.steps = 0
        self.planner_stream = ""
        self.failed: dict[str, dict] = {}  # actions that failed (for retry)
        self.focus_hwnd = 0  # window that was in front when an approval was asked

    def start(self) -> None:
        with self.lock:
            self.stopped.clear()
            self.paused.clear()
            self.history, self.pending, self.goals, self.steps = [], {}, [], 0
            self.failed = {}

    def record(self, entry: dict) -> None:
        with self.lock:
            self.history.append(entry)
            del self.history[:-MAX_HISTORY]


SESSION = Session()


def status() -> dict:
    try:
        w, h = screen_size()
    except RequestError as err:
        return {"available": False, "platform": sys.platform, "error": {"code": err.code, "message": err.message}}
    return {"available": True, "platform": sys.platform, "screen": {"width": w, "height": h}}


def start() -> dict:
    SESSION.start()
    threading.Thread(target=vision.auto_start, name="fidex-vision-auto", daemon=True).start()  # the eye comes up with the hand
    return status()


def stop() -> dict:
    """Stops everything at once: the planner's model call, and any action that is typing/waiting."""
    SESSION.stopped.set()
    SESSION.paused.clear()  # a paused action must wake up and see the Stop
    with SESSION.lock:
        sid = SESSION.planner_stream
        SESSION.pending.clear()
    if sid:
        ai.cancel(sid)
    log.info("hands stopped by the user")
    return {"stopped": True}


def pause(paused) -> dict:
    """Pause Actions / Resume Actions. While paused every action waits at execute(); the brain keeps thinking and planning,
    and the held action runs (in order, once) the moment the user resumes."""
    if paused:
        SESSION.paused.set()
    else:
        SESSION.paused.clear()
    log.info("actions %s", "paused" if paused else "resumed")
    return {"paused": bool(paused)}


def _check_stopped() -> None:
    if SESSION.stopped.is_set():
        raise RequestError(HANDS_STOPPED, "Stopped by the user.")


# ---------- planning (Qwen decides) ----------
def _history_text() -> str:
    with SESSION.lock:
        items = list(SESSION.history[-8:])
    if not items:
        return "(no actions yet)"
    return "\n".join(f"- {i['action']}: " + ("ok" + (f" ({i['detail']})" if i.get("detail") else "") if i["ok"] else f"FAILED: {i['error']}") if "action" in i else f"- user: {i['note']}" for i in items)


def parse_plan(text: str) -> dict:
    start_i, end_i = text.find("{"), text.rfind("}")
    if start_i < 0 or end_i <= start_i:
        return {"say": text.strip()[:600], "action": None, "done": False}
    try:
        obj = json.loads(text[start_i : end_i + 1])
    except ValueError:
        return {"say": text.strip()[:600], "action": None, "done": False}
    if not isinstance(obj, dict):
        return {"say": text.strip()[:600], "action": None, "done": False}
    say = obj.get("say")
    return {"say": say.strip()[:600] if isinstance(say, str) else "", "action": obj.get("action"), "done": obj.get("done") is True}


def _ask_qwen(messages: list[dict], on_token=None, num_predict: int | None = None, model_name: str | None = None) -> str:
    vision.yield_to_brain()  # planning always has priority over a Live Vision analysis in flight
    sid = "hands-" + uuid.uuid4().hex[:12]
    stream = ai._register(sid)
    with SESSION.lock:
        SESSION.planner_stream = sid
    try:
        got = False
        while not got:
            got = ai._gen_lock.acquire(timeout=0.1)
            if not got and SESSION.stopped.is_set():
                break
        if not got:
            raise RequestError(HANDS_STOPPED, "Stopped by the user.")
        try:
            if SESSION.stopped.is_set():
                raise RequestError(HANDS_STOPPED, "Stopped by the user.")
            if ai._soft_switch() and messages and messages[-1].get("role") == "user" and ai.NO_THINK not in str(messages[-1].get("content")):  # thinking is OFF for the brain: steps only, no reasoning tokens
                messages = messages[:-1] + [{**messages[-1], "content": str(messages[-1]["content"]) + " " + ai.NO_THINK}]
            text, timings = ai._stream_ask(messages, on_token or (lambda t: None), think=False, stream=stream, num_predict=num_predict, model_name=model_name)
        finally:
            ai._gen_lock.release()
    finally:
        ai._unregister(sid)
        with SESSION.lock:
            SESSION.planner_stream = ""
    if SESSION.stopped.is_set() or timings.get("cancelled"):
        raise RequestError(HANDS_STOPPED, "Stopped by the user.")
    return text


def plan(instruction=None) -> dict:
    """Qwen decides the next supported action. instruction=None continues the current one using the real results so far."""
    _check_stopped()
    if instruction is not None:
        if not isinstance(instruction, str) or not instruction.strip():
            raise RequestError(INVALID_PAYLOAD, "'instruction' must be non-empty text.")
        instruction = instruction.strip()[:2000]
        with SESSION.lock:
            SESSION.goals.append(instruction)
            del SESSION.goals[:-4]
            SESSION.steps = 0
    elif not SESSION.goals:
        raise RequestError(INVALID_PAYLOAD, "No instruction yet.")
    with SESSION.lock:
        if SESSION.steps >= MAX_STEPS:
            return {"say": f"I stopped after {MAX_STEPS} actions without finishing. Tell me how to continue.", "action": None, "done": True, "limit": True}
        goals = list(SESSION.goals)
    w, h = screen_size()
    pg = _pg()
    system = SYSTEM_PROMPT.format(w=w, h=h, wm=w - 1, hm=h - 1, cx=w // 2, cy=h // 2)
    user = "User instructions (oldest first):\n" + "\n".join(f"{i + 1}. {g}" for i, g in enumerate(goals)) + "\n\nReal results of earlier actions:\n" + _history_text() + (("\n\n" + vision.context()) if vision.context() else "") + "\n\nDecide the next step for the latest instruction."
    parsed = parse_plan(_ask_qwen([{"role": "system", "content": system}, {"role": "user", "content": user}]))
    action = None
    if parsed["action"] is not None:
        try:
            action = normalize_action(parsed["action"], (w, h), pg.KEYBOARD_KEYS)
        except RequestError as err:
            SESSION.record({"action": "planned an unsupported action", "ok": False, "error": err.message})
            return {"say": f"I cannot do that: {err.message}", "action": None, "done": False, "invalid": err.message}
    _check_stopped()
    out = {"say": parsed["say"], "action": None, "done": parsed["done"] and action is None, "last": False, "screen": {"width": w, "height": h}}
    if action is not None:
        out["action"] = register(action)
        out["last"] = parsed["done"]  # Qwen says this action finishes the instruction: no second model call afterwards
    return out


PLAN_ALL_PROMPT = (
    "You are the planner for FIDEX AI Windows Hands. Break the user's instruction into the COMPLETE ordered list of actions, once: "
    "a fast executor then runs the list with no further model help, so it must be complete. Screen {w}x{h}, centre ({cx},{cy}). "
    "You cannot see the screen, so never guess where buttons are: use keyboard shortcuts and typing, not clicks. "
    "After open_app add a wait (code/chrome/word 4 seconds, notepad/calc 2). After a hotkey that opens a dialog add wait 1.\n"
    "Actions: "
    '{{"type":"open_app","name":"notepad"}} | {{"type":"type","text":"hi"}} (ASCII) | {{"type":"press","key":"enter"}} | {{"type":"hotkey","keys":["ctrl","s"]}} | '
    '{{"type":"click","x":100,"y":200,"button":"left","clicks":1}} | {{"type":"move","x":100,"y":200}} | {{"type":"scroll","amount":-300}} | {{"type":"wait","seconds":1}}\n'
    "open_app names: notepad, calc, code (Visual Studio Code), chrome, msedge, explorer, cmd, mspaint, taskmgr.\n"
    'Example "open notepad and type hi": {{"steps":[{{"type":"open_app","name":"notepad"}},{{"type":"wait","seconds":2}},{{"type":"type","text":"hi"}}]}}\n'
    'Example "open vs code and create a new file app.py": {{"steps":[{{"type":"open_app","name":"code"}},{{"type":"wait","seconds":4}},{{"type":"hotkey","keys":["ctrl","n"]}},'
    '{{"type":"hotkey","keys":["ctrl","s"]}},{{"type":"wait","seconds":1}},{{"type":"type","text":"app.py"}},{{"type":"press","key":"enter"}}]}}\n'
    'Reply with ONE JSON object only, no markdown: {{"steps":[...],"say":"<only when steps is empty: short reason>"}}. At most {max} steps.'
)


_UNLOAD_TIMER: threading.Timer | None = None


def _ollama_keep(keep_alive) -> None:
    """Tells Ollama how long to keep the model in RAM: 0 unloads it now, a duration loads it (no prompt) and keeps it warm.
    Uses the same host, model and num_ctx as real requests: a different num_ctx makes Ollama reload the model on the next call."""
    try:
        import urllib.request  # noqa: PLC0415

        body = {"model": PLANNER_MODEL or ai.model(), "keep_alive": keep_alive}
        if keep_alive != 0:
            body["options"] = {"num_ctx": ai.NUM_CTX}
        req = urllib.request.Request(ai.host() + "/api/generate", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        ai._OPENER.open(req, timeout=120).read()  # noqa: S310
        log.info("brain keep_alive=%s (%s)", keep_alive, body["model"])
    except Exception as err:  # noqa: BLE001
        log.warning("could not set the model keep-alive: %s", err)


def _unload_brain() -> None:
    """Frees the model's RAM. Best effort, in the background."""
    threading.Thread(target=_ollama_keep, args=(0,), daemon=True).start()


def _cancel_unload() -> None:
    global _UNLOAD_TIMER
    with SESSION.lock:
        if _UNLOAD_TIMER is not None:
            _UNLOAD_TIMER.cancel()
            _UNLOAD_TIMER = None


def _schedule_unload(delay: float = UNLOAD_DELAY) -> None:
    """Keeps the model warm for the next step/task, then frees the RAM after `delay` seconds without use."""
    global _UNLOAD_TIMER
    _cancel_unload()
    timer = threading.Timer(delay, _unload_brain)
    timer.daemon = True
    with SESSION.lock:
        _UNLOAD_TIMER = timer
    timer.start()


def warm() -> dict:
    """Loads the model now (in the background) so it is ready by the time the first model step is needed."""
    _cancel_unload()
    threading.Thread(target=_ollama_keep, args=(ai.KEEP_ALIVE,), daemon=True).start()
    threading.Thread(target=vision.auto_start, name="fidex-vision-auto", daemon=True).start()  # the eye is already watching when the planner starts
    return {"warming": True}


def parse_steps(text: str) -> tuple[list, str]:
    obj = None
    a, b = text.find("{"), text.rfind("}")
    if 0 <= a < b:
        try:
            obj = json.loads(text[a : b + 1])
        except ValueError:
            obj = None
    if not isinstance(obj, dict):
        a, b = text.find("["), text.rfind("]")
        try:
            obj = {"steps": json.loads(text[a : b + 1])} if 0 <= a < b else None
        except ValueError:
            obj = None
    if not isinstance(obj, dict):
        return [], text.strip()[:600]
    steps, say = obj.get("steps"), obj.get("say")
    return (steps if isinstance(steps, list) else []), (say.strip()[:600] if isinstance(say, str) else "")


def plan_all(instruction) -> dict:
    """The brain plans the WHOLE instruction in one call, then is unloaded from RAM. The returned steps are validated,
    registered and ready: the client runs them one after another with hands.execute and no model involved."""
    _check_stopped()
    if not isinstance(instruction, str) or not instruction.strip():
        raise RequestError(INVALID_PAYLOAD, "'instruction' must be non-empty text.")
    instruction = TASK_PREFIX.sub("", instruction.strip(), count=1)[:2000]
    with SESSION.lock:
        SESSION.goals.append(instruction)
        del SESSION.goals[:-4]
        SESSION.steps = 0
    w, h = screen_size()
    pg = _pg()
    system = PLAN_ALL_PROMPT.format(w=w, h=h, cx=w // 2, cy=h // 2, max=MAX_PLAN_STEPS)
    try:
        text = _ask_qwen([{"role": "system", "content": system}, {"role": "user", "content": (instruction + "\n\n" + vision.context()) if vision.context() else instruction}])
    finally:
        if UNLOAD_AFTER_PLAN:
            _unload_brain()
    raw_steps, say = parse_steps(text)
    if not raw_steps:
        return {"say": say or "I cannot do that with the supported actions.", "steps": []}
    if len(raw_steps) > MAX_PLAN_STEPS:
        raise RequestError(ACTION_INVALID, f"The plan has more than {MAX_PLAN_STEPS} steps. Ask for a smaller task.")
    actions = []
    for i, raw in enumerate(raw_steps, 1):
        try:
            actions.append(normalize_action(raw, (w, h), pg.KEYBOARD_KEYS))
        except RequestError as err:
            raise RequestError(ACTION_INVALID, f"Step {i} of the plan is not valid: {err.message}") from None
    _check_stopped()
    return {"say": say, "steps": [register(a) for a in actions]}


TASK_PREFIX = re.compile(r"^task\s*:\s*", re.I)

# Planning can take a while (model load + generation). It runs in the background and the client asks for the result,
# so no single request waits long and nothing times out: the only way to cancel is Stop.
PLAN_JOBS: dict[str, dict] = {}


def plan_all_start(instruction) -> dict:
    _check_stopped()
    if not isinstance(instruction, str) or not instruction.strip():
        raise RequestError(INVALID_PAYLOAD, "'instruction' must be non-empty text.")
    jid = uuid.uuid4().hex[:12]
    job = {"state": "running", "started": time.monotonic(), "elapsed": 0.0, "result": None, "error": None}
    PLAN_JOBS[jid] = job

    def work() -> None:
        try:
            job["result"] = plan_all(instruction)
        except RequestError as err:
            job["error"] = {"code": err.code, "message": err.message}
        except Exception as err:  # noqa: BLE001
            log.exception("planning failed")
            job["error"] = {"code": ACTION_FAILED, "message": f"{type(err).__name__}: {err}"}
        finally:
            job["elapsed"] = round(time.monotonic() - job["started"], 1)
            job["state"] = "done"

    threading.Thread(target=work, daemon=True).start()
    return {"job": jid}


def plan_all_result(job_id) -> dict:
    job = PLAN_JOBS.get(job_id) if isinstance(job_id, str) else None
    if job is None:
        raise RequestError(INVALID_PAYLOAD, "Unknown or expired planning job.")
    if job["state"] == "running":
        return {"state": "running", "elapsed": round(time.monotonic() - job["started"], 1)}
    PLAN_JOBS.pop(job_id, None)
    if job["error"]:
        return {"state": "error", "elapsed": job["elapsed"], "error": job["error"]}
    return {"state": "done", "elapsed": job["elapsed"], **job["result"]}


# ---------- Incremental Read-and-Execute (IRE) ----------
# The planner writes ONE action per line. Each line is parsed, validated and handed to the client the moment it is complete,
# while the model keeps writing the rest, so the first action runs without waiting for the whole plan. The client executes
# strictly in order and waits for each real result; a failure cancels the rest. Approval rules are unchanged, and the
# consequential steps (send / delete / buy / submit) always need the user's approval.
PLANNER_MODEL = os.environ.get("FIDEX_PLANNER_MODEL") or None  # optional smaller/faster model used ONLY for planning (e.g. set FIDEX_PLANNER_MODEL); chat keeps the normal model
PLANNER_NUM_PREDICT = 1200  # the plan includes the full text of any file it writes, so it needs more room than a chat answer
ASK_FOR_CONSEQUENTIAL = False  # True brings back the Approve question for steps that send / delete / buy / submit (the model marks them)
IRE_PROMPT = r"""You are the Windows planner. Do EXACTLY and ONLY what the user said, in the order said, with the exact app/folder/file they named. Never open or create anything they did not ask for. A separate EYE looks at the real screen when each step runs, so for ANYTHING to click write `clickon <what to click, in words>`. NEVER refuse, never say you cannot see the screen, never ask for coordinates. Output ONLY steps, one per line, no explanations. A `say` line is at most 8 words. Each line runs the moment it is written.
mkdir <path>   (ONLY when the user says create / make / new folder)
file <path> | <full content; \n = new line>   (ONLY for a NEW file the user asked to create)
append <path> | <text>   (add a line at the END of an EXISTING file)
after <path> | <anchor text already in the file> | <new text>   (insert below that line of an EXISTING file)
before <path> | <anchor text already in the file> | <new text>   (insert above that line, e.g. before </body>)
cmd <command> || <other way to do it> || <another way>   (runs in cmd, shows the real result, tries the next way if one fails)
waitme <short message>   (STOP here until the user says go)
open <notepad|explorer|code> | <folder or file>
app <name>   (the EXACT app the user named: notepad calc mspaint taskmgr cmd explorer chrome msedge code)
keys win+r
type <text>
press <key>
wait <seconds>
clickon <what to click, in words>   (ALWAYS prefer this to click x y)
click <x> <y>   (only if the exact pixel is known)
say <short text>   (only to ask something or say you cannot)
RULES: 1) "my / existing / already existing / the folder X / the project / the html / continue / add to / edit / update" = work INSIDE what exists (see 'Existing' below): NEVER mkdir, NEVER write a new file, use append/after/before on the real file. 2) If the user says wait for me / stop and wait / let me check / until I say, put `waitme` at that exact point (after each section if they said so) and do NOT continue past it. 3) Do every part of the task; never stop early. 4) Check a version or run a command = `cmd`, always with other ways (python: `cmd python --version || py --version || python3 --version`). 5) Chrome profile / account: `keys win+r`, `type chrome`, `press enter`, `wait 3`, `clickon <the profile asked for> in the Chrome profile picker`. 6) Never use the Windows Start search or Microsoft Store to open an app: use `app <name>`.
Paths: desktop/name/file.ext (also documents/ and downloads/); a bare name is on the Desktop. Web page: keys win+r, type it, press enter. Max <MAX> steps. Skip anything already done.<CONSEQ>
Example: add the line <p>Hi</p> to index.html in my folder shop, then wait for me
after desktop/shop/index.html | <body> | <p>Hi</p>
waitme Line added. Tell me when to continue."""
CONSEQ_LINE = ' Add "consequential":true to the single action that really sends a message, deletes something, or buys/pays/submits.'
DESTRUCTIVE = re.compile(r"\b(format\s+[a-z]:|shutdown|rmdir\s+/s|rd\s+/s|del\s+/[sfq]|remove-item|rm\s+-rf|diskpart|reg\s+delete|cipher\s+/w)", re.I)
WANTS_DESTRUCTIVE = re.compile(r"\b(delete|remove|erase|wipe|format|shut\s*down|shutdown|restart|clean)\b", re.I)
RISKY_GOAL = re.compile(r"\b(send|message|text|reply|post|email|delete|remove|erase|buy|purchase|pay|order|checkout|submit|transfer|publish)\b", re.I)
SEARCH_KEYS = ({"ctrl", "f"}, {"ctrl", "k"}, {"ctrl", "e"}, {"ctrl", "l"}, {"ctrl", "n"})
IRE_JOBS: dict[str, dict] = {}


def parse_step_line(line: str):
    """One planner line -> a raw action dict, {"say": ...}, or None. JSON lines are still accepted."""
    line = line.strip().strip("`").strip()
    if not line:
        return None
    if line.startswith("{"):
        try:
            return json.loads(line)
        except ValueError:
            return None
    cmd, _, rest = line.partition(" ")
    cmd, rest = cmd.lower().rstrip(":"), rest.strip()
    if cmd == "say":
        return {"say": rest}
    if cmd == "mkdir":
        return {"type": "make_dir", "path": rest}
    _nl = lambda t: re.sub(r"\\(n|t|\\)", lambda m: {"n": "\n", "t": "\t", "\\": "\\"}[m.group(1)], t)  # noqa: E731
    if cmd == "append":
        path, _, text = rest.partition(" | ")
        return {"type": "edit_file", "mode": "append", "path": path.strip(), "text": _nl(text)}
    if cmd in ("after", "before"):
        parts = rest.split(" | ", 2)
        if len(parts) == 3:
            return {"type": "edit_file", "mode": cmd, "path": parts[0].strip(), "anchor": parts[1].strip(), "text": _nl(parts[2])}
        return None
    if cmd == "cmd":
        c = [x.strip() for x in rest.split("||") if x.strip()]
        return {"type": "run_cmd", "command": c[0], "alts": c[1:4]} if c else None
    if cmd == "waitme":
        return {"type": "wait_user", "message": rest or "Waiting for you. Tell me when to continue."}
    if cmd == "file":
        path, sep, content = rest.partition(" | ")
        content = re.sub(r"\\(n|t|\\)", lambda m: {"n": "\n", "t": "\t", "\\": "\\"}[m.group(1)], content) if sep else ""
        return {"type": "write_file", "path": path.strip(), "content": content}
    if cmd == "open":
        parts = [p.strip() for p in rest.split("|")]
        if len(parts) == 2 and parts[0].lower() in ("notepad", "code") and re.search(r"\.\w{1,5}$", parts[1]):  # open notepad | folder/file.ext
            folder = parts[1].replace("\\", "/").rsplit("/", 1)[0] if "/" in parts[1].replace("\\", "/") else "desktop"
            return {"type": "open_path", "app": parts[0].lower(), "path": folder, "file": parts[1]}
        if len(parts) >= 2 and parts[0].lower() in ("notepad", "explorer", "code"):
            out = {"type": "open_path", "app": parts[0].lower(), "path": parts[1]}
            if len(parts) > 2 and parts[2]:
                out["file"] = parts[2]
            return out
        return {"type": "open_app", "name": rest}
    if cmd == "app":
        return {"type": "open_app", "name": rest}
    if cmd == "keys":
        keys = [k.strip().lower() for k in rest.split("+") if k.strip()]
        return {"type": "hotkey", "keys": keys} if len(keys) > 1 else {"type": "press", "key": keys[0] if keys else ""}
    if cmd == "press":
        return {"type": "press", "key": rest.lower()}
    if cmd == "type":
        return {"type": "type", "text": rest}
    if cmd == "wait":
        try:
            return {"type": "wait", "seconds": float(rest.split()[0])}
        except (ValueError, IndexError):
            return None
    if cmd in ("clickon", "click_on", "rightclickon", "doubleclickon"):
        return {"type": "click_on", "target": rest, "button": "right" if cmd.startswith("right") else "left", "clicks": 2 if cmd.startswith("double") else 1}
    if cmd == "click":
        nums = re.findall(r"\d+", rest)
        if len(nums) >= 2:
            return {"type": "click", "x": int(nums[0]), "y": int(nums[1]), "button": "right" if "right" in rest.lower() else "left", "clicks": 2 if "double" in rest.lower() else 1}
    return None  # chatter or an unknown line: ignored


class _ObjectScanner:
    """Pulls complete top-level JSON objects out of streamed text as soon as their closing brace arrives."""

    def __init__(self) -> None:
        self.buf, self.pos, self.depth, self.start, self.in_str, self.esc = "", 0, 0, -1, False, False

    def feed(self, chunk: str) -> list[str]:
        self.buf += chunk
        out = []
        while self.pos < len(self.buf):
            c = self.buf[self.pos]
            if self.in_str:
                if self.esc:
                    self.esc = False
                elif c == "\\":
                    self.esc = True
                elif c == '"':
                    self.in_str = False
            elif c == '"' and self.depth > 0:
                self.in_str = True
            elif c == "{":
                if self.depth == 0:
                    self.start = self.pos
                self.depth += 1
            elif c == "}" and self.depth > 0:
                self.depth -= 1
                if self.depth == 0:
                    out.append(self.buf[self.start : self.pos + 1])
            self.pos += 1
        return out


def _is_consequential(raw: dict, action: dict, goal: str, prev: list[dict]) -> bool:
    if not ASK_FOR_CONSEQUENTIAL:
        return False
    if raw.get("consequential") is True:
        return True
    k = action["type"]
    keys = {action["key"]} if k == "press" else set(action.get("keys", [])) if k == "hotkey" else set()
    if "delete" in keys:
        return True
    if "enter" in keys and RISKY_GOAL.search(goal):  # typed text + Enter is the send pattern, unless it only confirms a search box
        real = [p for p in prev if p["type"] != "wait"]
        if real and real[-1]["type"] == "type":
            before = real[-2] if len(real) > 1 else {}
            opened_search = before.get("type") == "hotkey" and set(before.get("keys", [])) in SEARCH_KEYS
            return not opened_search
    return False


_Q_START = re.compile(r"^\s*(what|which|what's|whats|describe|tell me|can you see|do you see|look at|show me what)\b", re.I)
_ACT_WORDS = re.compile(r"\b(open|click|type|close|press|launch|start|write|scroll|move|minimi[sz]e|maximi[sz]e|go to|search)\b", re.I)


def _is_screen_question(text: str) -> bool:
    return bool(ai.SCREEN_QUESTION.search(text) and _Q_START.search(text) and not _ACT_WORDS.search(text))


def _desktop_items() -> list[str]:
    """INSTANT (no model): names of the icons on the desktop, read from Windows."""
    try:
        import uiautomation as auto  # noqa: PLC0415

        names: list[str] = []
        for cls in ("Progman", "WorkerW"):
            root = auto.PaneControl(searchDepth=1, ClassName=cls)
            if not root.Exists(0, 0):
                continue
            for ctrl, _d in auto.WalkControl(root, includeTop=False, maxDepth=6):
                if ctrl.ControlTypeName == "ListItemControl" and ctrl.Name and not ctrl.IsOffscreen and ctrl.Name not in names:
                    names.append(ctrl.Name)
            if names:
                break
        return names
    except Exception:  # noqa: BLE001
        return []


def _screen_answer(text: str) -> str:
    t0 = time.monotonic()
    try:
        return _screen_answer_inner(text)
    finally:
        timed("screen_answer", t0)


def _screen_answer_inner(text: str) -> str:
    if re.search(r"\b(?:folders?|icons?|files?|shortcuts?|apps?)\b", text, re.I) and re.search(r"\b(?:screen|desktop)\b", text, re.I):
        items = [p.stem if p.suffix.lower() in (".lnk", ".url") else p.name for p in _desktop_fs_items()]  # METHOD 1: filesystem
        for extra in _desktop_items():  # + what Windows shows that is not a file (Recycle Bin, This PC), when UI Automation is installed
            if extra not in items and extra.lower() not in (i.lower() for i in items):
                items.append(extra)
        if items:
            return "On your desktop: " + ", ".join(items) + "."
    win = vision.real_active_window()
    sentence = vision.window_sentence(win)
    if ai.ACTIVE_ONLY.search(text) and not ai.SEE_WORDS.search(text):  # instant: Windows knows it, no model
        return sentence or "I could not read the active window."
    seen = vision.ask_screen(text)  # the eye answers exactly the question: no window names, no description
    if seen:
        return seen
    st = vision.status()
    why = (st.get("error") or {}).get("message") if isinstance(st.get("error"), dict) else ""
    return "I could not look at the screen." + (f" {why}" if why else "")


BROWSERS = {"chrome": "chrome", "google chrome": "chrome", "msedge": "msedge", "edge": "msedge", "microsoft edge": "msedge", "firefox": "firefox"}


def browser_steps(name: str) -> list[dict]:
    return [{"type": "hotkey", "keys": ["win", "r"]}, {"type": "wait", "seconds": 0.6}, {"type": "type", "text": BROWSERS.get(name, name)}, {"type": "press", "key": "enter"}, {"type": "wait", "seconds": 3}]


def show_desktop() -> dict:
    """Minimises every window (Win+M, not Win+D: it never toggles them back) so the new task starts on a clear desktop."""
    _check_stopped()
    try:
        _pg().hotkey("win", "m")
        time.sleep(0.6)
    except Exception:  # noqa: BLE001
        log.exception("show desktop failed")
    return {"ok": True}


PROJECT_WORDS = re.compile(r"\b(it|this|that|these|the (?:project|folder|site|page|html|css|file|code|app|website)|continue|same|already|existing|my|add|edit|update|change|insert)\b", re.I)
NEW_WORDS = re.compile(r"\b(?:create|make|new)\b.{0,25}\bfolder\b", re.I)


def _project_context(instruction: str) -> str:
    """Names of the REAL folders/files the task is about (no model call): so the planner continues the user's project instead of starting a new one."""
    low = instruction.lower()
    found: list[Path] = []
    try:
        for base in ("desktop", "documents", "downloads"):
            root_ = fs_actions.known_folder(base)
            if root_.is_dir():
                for d in list(root_.iterdir())[:300]:
                    if d.is_dir() and not d.name.startswith(".") and len(d.name) >= 3 and d.name.lower() in low:
                        found.append(d)
        last = fs_actions.LAST_PROJECT[0]
        if last and Path(last).is_dir() and Path(last) not in found and not NEW_WORDS.search(instruction) and (PROJECT_WORDS.search(instruction) or not found):
            found.append(Path(last))
    except OSError:
        return ""
    out = []
    for d in found[:3]:
        try:
            names = sorted(f.name for f in d.iterdir() if not f.name.startswith("."))[:15]
        except OSError:
            continue
        out.append(f"folder {d.as_posix()} contains: {', '.join(names) or '(empty)'}")
    return "\n".join(out)[:450]


def ire_start(instruction, done=None) -> dict:
    """Starts incremental planning. Steps appear in the job as soon as each is complete: read them with ire_poll."""
    _check_stopped()
    if not isinstance(instruction, str) or not instruction.strip():
        raise RequestError(INVALID_PAYLOAD, "'instruction' must be non-empty text.")
    instruction = TASK_PREFIX.sub("", instruction.strip(), count=1)[:2000]
    done = [str(d)[:120] for d in done[:10]] if isinstance(done, list) else []
    with SESSION.lock:
        SESSION.goals.append(instruction)
        del SESSION.goals[:-4]
        SESSION.steps = 0
    w, h = screen_size()
    pg = _pg()
    _cancel_unload()
    threading.Thread(target=vision.auto_start, name="fidex-vision-auto", daemon=True).start()  # eyes on while the task runs; the user does not switch it on
    jid = uuid.uuid4().hex[:12]
    job = {"state": "running", "steps": [], "say": "", "error": None, "cancelled": False, "t0": time.monotonic(), "cond": threading.Condition()}
    IRE_JOBS[jid] = job
    if _is_screen_question(instruction):  # a QUESTION about the screen is answered by the Eye, not planned as mouse/keyboard steps
        def answer() -> None:
            try:
                job["say"] = _screen_answer(instruction)
            except Exception:  # noqa: BLE001
                log.exception("screen answer failed")
                job["say"] = "I could not look at the screen right now."
            finally:
                job["state"] = "done"
                _wake(job)

        threading.Thread(target=answer, daemon=True).start()
        return {"job": jid}
    system = IRE_PROMPT.replace("<W>", str(w)).replace("<H>", str(h)).replace("<MAX>", str(MAX_PLAN_STEPS)).replace("<DESKTOP>", fs_actions.known_folder("desktop").as_posix()).replace("<DOCS>", fs_actions.known_folder("documents").as_posix()).replace("<DL>", fs_actions.known_folder("downloads").as_posix()).replace("<CONSEQ>", CONSEQ_LINE if ASK_FOR_CONSEQUENTIAL else "") + (MOUSE_RULES if MOUSE_FIRST else "")  # constant text: the model reuses its cached prefix
    ctx = "\n".join(x for x in (brain.context(instruction, limit_act=2, limit_know=4), brain.secrets_for(instruction)) if x)[:700]  # SMALL on purpose: this machine reads ~17 tokens/s, so every extra 100 tokens of background is ~6 s of silence before the first step
    user = (("Background (use it to pick the right next step; do not repeat it):\n" + ctx + "\n\nTask:\n") if ctx else "") + instruction + (("\n\nAlready done (do not repeat):\n" + "\n".join(f"- {d}" for d in done)) if done else "")

    pc = _project_context(instruction)
    if pc:
        user = user + "\n\nExisting (work in these, do NOT create new ones):\n" + pc
    log.info("planner prompt ~%d tokens (system %d + task %d)", (len(system) + len(user)) // 4, len(system) // 4, len(user) // 4)

    def fail(code: str, message: str) -> None:
        if job["error"] is None:
            job["error"] = {"code": code, "message": message}
        job["cancelled"] = True
        _wake(job)
        with SESSION.lock:
            sid = SESSION.planner_stream
        if sid:
            ai.cancel(sid)

    def accept(raw) -> None:
        if not isinstance(raw, dict) or job["cancelled"]:
            return
        if raw.get("type") == "open_app" and str(raw.get("name", "")).strip().lower() in BROWSERS:  # browsers always open the proper way: Win+R, type the name, Enter
            for st in browser_steps(str(raw["name"]).strip().lower()):
                accept(st)
            return
        if isinstance(raw.get("steps"), list):  # the model wrapped a list anyway: take them in order
            for item in raw["steps"]:
                accept(item)
            return
        if "type" not in raw:
            if isinstance(raw.get("say"), str):
                job["say"] = raw["say"].strip()[:600]
            return
        if len(job["steps"]) >= MAX_PLAN_STEPS:
            return fail(ACTION_INVALID, f"The task needs more than {MAX_PLAN_STEPS} actions. Ask for a smaller task.")
        try:
            action = normalize_action(raw, (w, h), pg.KEYBOARD_KEYS, allow_fs=True)  # the planner may make folders/files (validated, inside the user's folder)
        except RequestError as err:
            return fail(ACTION_INVALID, f"Step {len(job['steps']) + 1} is not valid: {err.message}")
        if action["type"] == "type" and DESTRUCTIVE.search(action["text"]) and not WANTS_DESTRUCTIVE.search(instruction):
            return fail(ACTION_INVALID, "Blocked: the plan contained a destructive command you did not ask for.")
        if action["type"] == "run_cmd" and DESTRUCTIVE.search(action["command"]) and not WANTS_DESTRUCTIVE.search(instruction):
            return fail(ACTION_INVALID, "Blocked: the plan contained a destructive command you did not ask for.")
        prev = [s_["raw"] for s_ in job["steps"]]
        if not job["steps"]:
            log.info("planner: first step ready after %.1fs", time.monotonic() - job["t0"])
        job["steps"].append({"raw": action, "action": register(action, force_approval=_is_consequential(raw, action, instruction, prev))})
        _wake(job)  # the waiting poll returns at once: the hand starts this step with no polling delay

    try:  # FAST PATH: a task the recipe fully understands is planned in milliseconds, with NO model call
        fp = fast_plan.compile_plan(instruction, fs_actions.known_folder)  # folders/files are made directly (instant, no model, no mouse)
    except Exception:  # noqa: BLE001
        log.exception("fast plan failed; using the model planner")
        fp = None
    if fp is not None:
        for raw_step in fp["steps"]:
            accept(raw_step)
        job["say"] = "" if fp["steps"] else fp.get("say", "")  # steps ran: the UI reports "Finished"; no steps: it is a question for the user
        log.info("planner: fast recipe, %d steps in %d ms (no model)", len(job["steps"]), round((time.monotonic() - job["t0"]) * 1000))
        job["state"] = "done"
        _wake(job)
        return {"job": jid}

    buf, acc = "", ""

    def on_token(chunk) -> None:
        nonlocal acc, buf
        if not isinstance(chunk, str) or SESSION.stopped.is_set():
            return
        if acc and chunk.startswith(acc) and len(chunk) > len(acc):  # tolerate a callback that sends the whole text so far
            chunk, acc = chunk[len(acc) :], chunk
        else:
            acc += chunk
        buf += chunk
        while "\n" in buf:  # a complete line is a complete step: it starts running now while the model writes the next
            line, buf = buf.split("\n", 1)
            step = parse_step_line(line)
            if step is not None:
                accept(step)

    t_plan = time.monotonic()

    def work() -> None:
        try:
            text = _ask_qwen([{"role": "system", "content": system}, {"role": "user", "content": user}], on_token, PLANNER_NUM_PREDICT, PLANNER_MODEL)
            last = parse_step_line(buf)  # the final line has no newline after it
            if last is not None:
                accept(last)
            if not job["steps"] and not job["say"] and not job["error"]:
                _, say = parse_steps(text)
                job["say"] = say[:300] or "I cannot do that with the supported actions."
        except RequestError as err:
            if not job["cancelled"]:
                job["error"] = {"code": err.code, "message": err.message}
        except Exception as err:  # noqa: BLE001
            log.exception("incremental planning failed")
            if not job["cancelled"]:
                job["error"] = {"code": ACTION_FAILED, "message": f"{type(err).__name__}: {err}"}
        finally:
            log.info("planner finished: %d steps in %d ms", len(job["steps"]), round((time.monotonic() - t_plan) * 1000))
            if UNLOAD_AFTER_PLAN:
                _schedule_unload()  # not immediately: the next step or task would pay a full model reload
            job["state"] = "done"
            _wake(job)
            log.info("planner: %d steps, model finished after %.1fs", len(job["steps"]), time.monotonic() - job["t0"])

    threading.Thread(target=work, daemon=True).start()
    return {"job": jid}


IRE_LONG_POLL = 0.4  # seconds a poll waits for a new step before answering "nothing yet"


def _wake(job: dict) -> None:
    with job["cond"]:
        job["cond"].notify_all()


def ire_poll(job_id, cursor=0) -> dict:
    job = IRE_JOBS.get(job_id) if isinstance(job_id, str) else None
    if job is None:
        raise RequestError(INVALID_PAYLOAD, "Unknown or expired incremental job.")
    if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 0:
        raise RequestError(INVALID_PAYLOAD, "'cursor' must be a number.")
    if job["state"] == "running" and len(job["steps"]) <= cursor and not job["error"]:  # long-poll: return the instant a step is ready
        with job["cond"]:
            job["cond"].wait_for(lambda: job["state"] != "running" or len(job["steps"]) > cursor or job["error"] or SESSION.stopped.is_set(), timeout=IRE_LONG_POLL)
    state = job["state"]  # read first: steps appended after this are picked up by the next poll
    new = [s_["action"] for s_ in job["steps"][cursor:]]
    out = {"state": state, "steps": new, "say": job["say"], "error": job["error"]}
    if state == "done" and cursor + len(new) >= len(job["steps"]):
        IRE_JOBS.pop(job_id, None)
    return out


def ire_cancel(job_id) -> dict:
    """Stops the planner for this job (used after a failure or a declined approval). Does not stop Hands itself."""
    job = IRE_JOBS.get(job_id) if isinstance(job_id, str) else None
    if job is not None:
        job["cancelled"] = True
        _wake(job)
        with SESSION.lock:
            sid = SESSION.planner_stream
        if sid:
            ai.cancel(sid)
    return {"cancelled": job is not None}


def register(action: dict, trusted: bool = False, force_approval: bool = False) -> dict:
    """Registers an already-validated action as pending. Approval rules are unchanged: see requires_approval().
    trusted=True is used ONLY for a command the user typed themselves and the rule parser understood exactly
    (never for an action chosen by Qwen): typing the command is the permission, so no extra Approve click is asked."""
    aid = uuid.uuid4().hex[:12]
    needs = (requires_approval(action) or force_approval) and not trusted
    with SESSION.lock:
        SESSION.pending[aid] = {"action": action, "approved": not needs, "needs_approval": needs, "used": False}
        SESSION.steps += 1
    return {"id": aid, "describe": describe(action), "requires_approval": needs, **action}


def propose(raw_action, instruction: str | None = None, trusted: bool = False) -> dict:
    """Validates an action chosen by the Action Decision Engine exactly like a Qwen-planned one and registers it as pending.
    It is NOT executed here: hands.approve / hands.execute still apply."""
    _check_stopped()
    if instruction:
        with SESSION.lock:
            SESSION.goals.append(instruction[:2000])
            del SESSION.goals[:-4]
            SESSION.steps = 0
    w, h = screen_size()
    threading.Thread(target=vision.auto_start, name="fidex-vision-auto", daemon=True).start()
    action = normalize_action(raw_action, (w, h), _pg().KEYBOARD_KEYS)
    return register(action, trusted)


def approve(action_id, approved) -> dict:
    if not isinstance(approved, bool):
        raise RequestError(INVALID_PAYLOAD, "'approved' must be true or false.")
    with SESSION.lock:
        entry = SESSION.pending.get(action_id) if isinstance(action_id, str) else None
        if entry is None:
            raise RequestError(INVALID_PAYLOAD, "Unknown or expired action id.")
        if approved:
            _check_stopped()
            entry["approved"] = True
        else:
            SESSION.pending.pop(action_id, None)
            SESSION.record({"action": describe(entry["action"]), "ok": False, "error": "the user declined this action"})
    return {"id": action_id, "approved": approved}


# ---------- focus (the Approve click moves keyboard focus to FIDEX) ----------
def focus_mark() -> dict:
    """Remembers the window that is in front right now; called just before an approval is asked."""
    hwnd = 0
    if sys.platform == "win32":
        import ctypes  # noqa: PLC0415

        hwnd = int(ctypes.windll.user32.GetForegroundWindow())
    SESSION.focus_hwnd = hwnd
    return {"marked": bool(hwnd)}


def _restore_focus() -> None:
    """Gives the keyboard back to the window that was in front before the approval click. If that is impossible nothing is pressed."""
    hwnd, SESSION.focus_hwnd = SESSION.focus_hwnd, 0
    if not hwnd or sys.platform != "win32":
        return
    import ctypes  # noqa: PLC0415

    u = ctypes.windll.user32
    if u.GetForegroundWindow() == hwnd:
        return
    u.keybd_event(0x12, 0, 0, 0)  # a tap on Alt lets SetForegroundWindow through Windows' foreground lock
    u.keybd_event(0x12, 0, 2, 0)
    if u.IsIconic(hwnd):
        u.ShowWindow(hwnd, 9)
    u.SetForegroundWindow(hwnd)
    for _ in range(20):
        if u.GetForegroundWindow() == hwnd:
            return
        time.sleep(0.05)
    raise RequestError(ACTION_FAILED, "Could not return keyboard focus to the app that was in front, so nothing was pressed.")


# ---------- the eye tells the hand where to click ----------
LOCATE_PROMPT = (
    "Look at the screenshot and find the thing described by the user. Answer with ONLY its click point as two numbers: x y, on a 0 to 1000 grid "
    "(0 0 is the top-left corner of the screenshot, 1000 1000 the bottom-right, the centre of the target). If it is not visible answer exactly: NOTFOUND"
)


LOCATE_WIDTH = int(os.environ.get("FIDEX_LOCATE_WIDTH", "640"))  # sharper than the describe size: click points need detail


def _close_button(action: dict):
    """Instant path (no model): 'close' button of the window in front = top-right corner of its visible frame."""
    t = action["target"].lower()
    if not re.search(r"\bclose\b|\bexit\b", t) or not re.search(r"button|window|app|program|\bx\b|^close$|^exit$", t):
        return None
    win = vision.real_active_window()  # the app behind FIDEX AI when the user is typing in it
    if not win or vision._is_fidex(win):  # never close FIDEX AI itself by guessing
        return None
    l, tp, r, _b = win["rect"]
    w, h = screen_size()
    sc = win["dpi"] / 96.0
    x, y = min(r, w) - round(23 * sc), max(tp, 0) + round(15 * sc)
    if not (0 <= x < w and 0 <= y < h):
        return None
    return {"type": "click", "x": x, "y": y, "button": action["button"], "clicks": action["clicks"]}


_UIA_STOP = {"the", "a", "an", "button", "icon", "menu", "item", "option", "on", "of", "to", "in", "at", "empty", "area", "space", "folder", "file", "click"}


def _uia_available() -> bool:
    try:
        import importlib.util  # noqa: PLC0415

        return importlib.util.find_spec("uiautomation") is not None
    except Exception:  # noqa: BLE001
        return False


MOUSE_FIRST = os.environ.get("FIDEX_MOUSE_FIRST", "1") != "0" and _uia_available()
MOUSE_RULES = (
    "\nUSE THE MOUSE like a person (the eye finds every button instantly): open apps by `clickon` their Start menu, taskbar or desktop icon; NEVER make folders or files with the mouse: use `mkdir <path>` / `file <path> | <content>`; open things with `doubleclickon <name>`; "
    "use the keyboard only to type text or when no button exists."
)


def _uia_find(action: dict):
    """INSTANT locator (no model): reads the real Windows controls (buttons, menu items, icons) of the front window, taskbar, desktop and open menus. None if not found."""
    try:
        import uiautomation as auto  # noqa: PLC0415
    except ImportError:
        return None
    try:
        target = re.sub(r"\s+(?:on|in|at|from)\s+(?:the\s+|my\s+)?(?:desktop|screen|taskbar|start menu)\b.*$", "", action["target"].lower()).strip()
        words = [w for w in re.findall(r"[a-z0-9]+", target) if w not in _UIA_STOP]
        if not words:
            return None
        roots = []
        for finder in (lambda: auto.GetForegroundControl(), lambda: auto.MenuControl(searchDepth=1, ClassName="#32768"), lambda: auto.PaneControl(searchDepth=1, ClassName="Shell_TrayWnd"), lambda: auto.PaneControl(searchDepth=1, ClassName="Progman"), lambda: auto.PaneControl(searchDepth=1, ClassName="WorkerW")):
            try:
                c = finder()
                if c is not None and c.Exists(0, 0):
                    roots.append(c)
            except Exception:  # noqa: BLE001
                pass
        end, best = time.time() + 0.8, None
        for root in roots:
            for ctrl, _depth in auto.WalkControl(root, includeTop=True, maxDepth=9):
                if time.time() > end:
                    break
                name = (ctrl.Name or "").strip().lower()
                if not name or ctrl.IsOffscreen:
                    continue
                if name in target or all(w in name for w in words):
                    r = ctrl.BoundingRectangle
                    if r.width() > 0 and r.height() > 0 and (best is None or len(name) < best[0]):
                        best = (len(name), (r.left + r.right) // 2, (r.top + r.bottom) // 2)
            if best:
                break
        if not best:
            return None
        return {"type": "click", "x": best[1], "y": best[2], "button": action["button"], "clicks": action["clicks"]}
    except Exception:  # noqa: BLE001
        log.debug("uia locate failed", exc_info=True)
        return None


def _desktop_dirs():
    from pathlib import Path  # noqa: PLC0415

    dirs = [fs_actions.known_folder("desktop")]
    pub = os.environ.get("PUBLIC")
    if pub:
        dirs.append(Path(pub) / "Desktop")
    return [d for d in dirs if d.is_dir()]


def _desktop_fs_items() -> list:
    out = []
    for d in _desktop_dirs():
        for p in sorted(d.iterdir(), key=lambda x: x.name.lower()):
            if p.name.lower() == "desktop.ini" or p.name.startswith("."):
                continue
            out.append(p)
    return out


def _fs_open_target(action: dict) -> str | None:
    """METHOD 1 (direct filesystem): a double-click on a named desktop item is just 'open that path'. No locating, no mouse."""
    if action.get("clicks") != 2 or action.get("button") != "left":
        return None
    name = re.sub(r"\s+(?:on|in|at|from)\s+(?:the\s+|my\s+)?(?:desktop|screen)\b.*$", "", action["target"].lower()).strip()
    name = re.sub(r"\b(?:the|folder|file|icon|shortcut)\b", " ", name).split()
    name = " ".join(name)
    if not name or sys.platform != "win32":
        return None
    for p in _desktop_fs_items():
        if name in (p.name.lower(), p.stem.lower()):
            os.startfile(str(p))  # type: ignore[attr-defined]
            return f"opened {p}"
    return None


def _locate(action: dict) -> dict:
    """Live Vision finds action['target'] on the screen as it is right now and returns a plain click at that point."""
    t0 = time.monotonic()
    fast = _close_button(action)
    if fast:
        timed("locate.window_geometry", t0)
        return fast
    fast = _uia_find(action)
    if fast:
        timed("locate.uia", t0)
        return fast
    shot = vision.fresh_jpeg(timeout=3.0, width=LOCATE_WIDTH)
    if shot is None:
        st = vision.status()
        raise RequestError(ACTION_FAILED, f"The eye could not see the screen to find '{action['target']}'. " + ((st.get("error") or {}).get("message") or ""))
    w, h = screen_size()
    text = _ask_qwen([{"role": "system", "content": LOCATE_PROMPT}, {"role": "user", "content": "Find: " + action["target"], "images": [shot[0]]}], None, 24, vision.VISION_MODEL)
    nums = re.findall(r"\d+", text or "")
    if "NOTFOUND" in (text or "").upper() or len(nums) < 2:
        raise RequestError(ACTION_FAILED, f"I looked at the screen and could not see '{action['target']}'.")
    gx, gy = min(1000, int(nums[0])), min(1000, int(nums[1]))
    timed("locate.vision_model", t0)
    return {"type": "click", "x": round(gx / 1000 * (w - 1)), "y": round(gy / 1000 * (h - 1)), "button": action["button"], "clicks": action["clicks"]}


# ---------- execution ----------
def _open_app(name: str) -> str:
    if sys.platform == "win32":
        try:  # system applications are opened the proper way: Win+R, type the name, Enter (never Start search / the Store)
            pg = _pg()
            pg.hotkey("win", "r")
            time.sleep(0.6)
            _check_stopped()
            pg.write(name, interval=0.01)
            pg.press("enter")
            return "opened with Win+R"
        except RequestError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("Win+R launch failed; using ShellExecute")
        try:
            os.startfile(name)  # type: ignore[attr-defined]  # ShellExecute: resolves App Paths and PATH like the Run box
            return "launch requested from Windows"
        except OSError:
            # launchers such as VS Code's "code" are .cmd files ShellExecute cannot resolve: let cmd.exe find them on PATH
            proc = subprocess.Popen(["cmd", "/c", name], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
            try:
                rc = proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                return "launch requested via cmd"
            if rc != 0:
                raise RequestError(ACTION_FAILED, f"'{name}' was not found on this computer.") from None
            return "launched via cmd"
    path = shutil.which(name)
    if not path:
        raise RequestError(ACTION_FAILED, f"'{name}' was not found on this computer.")
    subprocess.Popen([path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return f"started {path}"


def _sleep(seconds: float) -> float:
    end, done = time.monotonic() + seconds, 0.0
    while True:
        left = end - time.monotonic()
        if left <= 0 or SESSION.stopped.is_set():
            break
        time.sleep(min(0.05, left))
    return round(seconds - max(0.0, end - time.monotonic()), 2)


def _set_clipboard(text: str) -> None:
    """Puts Unicode text on the Windows clipboard (ctypes, no extra package). Raises a clear error elsewhere."""
    if sys.platform != "win32":
        raise RequestError(ACTION_FAILED, "Paste needs the Windows clipboard.")
    import ctypes  # noqa: PLC0415
    from ctypes import wintypes  # noqa: PLC0415

    k32, u32 = ctypes.windll.kernel32, ctypes.windll.user32
    k32.GlobalAlloc.restype, k32.GlobalLock.restype = wintypes.HGLOBAL, ctypes.c_void_p
    k32.GlobalAlloc.argtypes, k32.GlobalLock.argtypes, k32.GlobalUnlock.argtypes = [wintypes.UINT, ctypes.c_size_t], [wintypes.HGLOBAL], [wintypes.HGLOBAL]
    u32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    data = (text.replace("\r\n", "\n").replace("\n", "\r\n") + "\0").encode("utf-16-le")
    for _ in range(20):  # another program may hold the clipboard for a moment
        if u32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise RequestError(ACTION_FAILED, "The clipboard is busy. Try again.")
    try:
        u32.EmptyClipboard()
        handle = k32.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
        if not handle:
            raise RequestError(ACTION_FAILED, "Could not allocate memory for the clipboard.")
        ptr = k32.GlobalLock(handle)
        ctypes.memmove(ptr, data, len(data))
        k32.GlobalUnlock(handle)
        if not u32.SetClipboardData(13, handle):  # CF_UNICODETEXT
            raise RequestError(ACTION_FAILED, "Could not write to the clipboard.")
    finally:
        u32.CloseClipboard()


# ---------- verification: an action only counts as done when its real effect is confirmed ----------
def _snapshot() -> dict:
    """Visible top-level windows and the foreground window (Windows only; empty elsewhere)."""
    if sys.platform != "win32":
        return {}
    import ctypes  # noqa: PLC0415
    from ctypes import wintypes  # noqa: PLC0415

    u = ctypes.windll.user32
    wins: dict[int, str] = {}

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lp):
        if u.IsWindowVisible(hwnd):
            n = u.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, buf, n + 1)
                wins[int(hwnd)] = buf.value
        return True

    u.EnumWindows(cb, 0)
    fg = int(u.GetForegroundWindow())
    return {"fg": fg, "fg_title": wins.get(fg, ""), "wins": wins}


def _poll(check, timeout: float, step: float = 0.15):
    end = time.monotonic() + timeout
    while True:
        _check_stopped()
        got = check()
        if got:
            return got
        if time.monotonic() >= end:
            return None
        time.sleep(step)


def _app_words(name: str) -> list[str]:
    base = re.sub(r"\.exe$", "", name.strip().lower()).rstrip(":")
    words = {base, base.replace(" ", "")}
    words.update({"calc": "calculator", "code": "visual studio code", "msedge": "edge", "mspaint": "paint", "taskmgr": "task manager", "cmd": "command prompt", "whatsapp": "whatsapp", "explorer": "file explorer"}.get(base, base).split("|"))
    return [w for w in words if w]


def _verify(action: dict, before: dict, detail: str, data: dict) -> str:
    """Confirms the REAL effect of an action. Returns a short note, or raises VERIFY_FAILED. Non-Windows hosts cannot see windows,
    so only checks that do not need them run there (and the note says so)."""
    k = action["type"]
    if k in ("move", "click"):
        return "pointer position confirmed"
    if k in fs_actions.FS_ACTIONS:
        if k in ("edit_file", "run_cmd", "wait_user"):
            return "result confirmed"
        if k in ("make_dir",) and not os.path.isdir(action["path"]):
            raise RequestError(VERIFY_FAILED, f"Verification failed: the folder {action['path']} does not exist.")
        if k == "write_file" and not os.path.isfile(action["path"]):
            raise RequestError(VERIFY_FAILED, f"Verification failed: the file {action['path']} does not exist.")
        if k not in fs_actions.NO_WINDOW_CHECK and sys.platform == "win32":  # (6s so the whole request stays inside the backend time limit)  # opening a folder/file in an app: a new or matching window must appear
            name = os.path.basename(action["path"]).lower()
            got = _poll(lambda: [h for h, t in _snapshot().get("wins", {}).items() if h not in before.get("wins", {}) or name in t.lower()], 6.0)
            if not got:
                raise RequestError(VERIFY_FAILED, f"Verification failed: no window for {action['path']} appeared.")
            return "window appeared"
        return "result confirmed on disk"
    if k == "open_app":
        if sys.platform != "win32":
            return "process started (window check needs Windows)"
        words = _app_words(action["name"])
        old = before.get("wins", {})

        def seen():
            snap = _snapshot()
            for h, t in snap.get("wins", {}).items():
                if h not in old or any(w in t.lower() for w in words):
                    return t or True
            return None

        got = _poll(seen, 6.0)
        if not got:
            raise RequestError(VERIFY_FAILED, f"Verification failed: no window for '{action['name']}' appeared within 6 seconds.")
        return f"window confirmed: {got}" if isinstance(got, str) else "window confirmed"
    if k in ("type", "paste"):
        if sys.platform != "win32":
            return "input sent (target check needs Windows)"
        after = _snapshot()
        if before.get("fg") and after.get("fg") != before.get("fg"):
            raise RequestError(VERIFY_FAILED, "Verification failed: the window in front changed while typing, so the text may have gone to the wrong place.")
        return "text went to the same window that was in front"
    if k == "hotkey" and sys.platform == "win32":
        keys = "+".join(action["keys"])
        if keys == "win+r":
            if not _poll(lambda: "run" in _snapshot().get("fg_title", "").lower(), 3.0):
                raise RequestError(VERIFY_FAILED, "Verification failed: the Run box did not open.")
            return "Run box confirmed"
        if keys in ("ctrl+n", "ctrl+s", "ctrl+o", "ctrl+shift+s"):  # these open a window/dialog or change the title: something must change
            def changed():
                s_ = _snapshot()
                return s_.get("fg") != before.get("fg") or s_.get("fg_title") != before.get("fg_title") or len(s_.get("wins", {})) != len(before.get("wins", {}))
            if not _poll(changed, 3.0):
                raise RequestError(VERIFY_FAILED, f"Verification failed: {keys} had no visible effect.")
            return "visible change confirmed"
    return "completed without error"


def _run(pg, action: dict) -> tuple[str, dict]:
    k = action["type"]
    if k in fs_actions.FS_ACTIONS:
        _check_stopped()
        return fs_actions.run(action)
    if k in ("click", "move"):
        cx, cy = pg.position()
        dist = math.hypot(action["x"] - cx, action["y"] - cy)
        glide = min(0.12, 0.02 + dist / 12000)  # the pointer travels there (short hop ~0.1s, full screen ~0.4s) instead of teleporting
        ease = getattr(pg, "easeInOutQuad", None)
        if ease is not None:
            pg.moveTo(action["x"], action["y"], duration=glide, tween=ease)
        else:
            pg.moveTo(action["x"], action["y"], duration=glide)
        _check_stopped()
        if k == "click":
            pg.click(action["x"], action["y"], clicks=action["clicks"], button=action["button"])
        pos = pg.position()
        if abs(pos[0] - action["x"]) > 3 or abs(pos[1] - action["y"]) > 3:  # success is only reported when the pointer really got there
            raise RequestError(ACTION_FAILED, f"The mouse did not reach ({action['x']}, {action['y']}); it is at ({pos[0]}, {pos[1]}).")
        return f"pointer at ({pos[0]}, {pos[1]})", {"x": int(pos[0]), "y": int(pos[1])}
    if k == "scroll":
        pg.scroll(action["amount"])
        return f"scrolled {action['amount']}", {"scrolled": action["amount"]}
    if k == "type":
        text, typed = action["text"], 0
        for i in range(0, len(text), TYPE_CHUNK):
            _check_stopped()
            chunk = text[i : i + TYPE_CHUNK]
            pg.write(chunk, interval=TYPE_INTERVAL)
            typed += len(chunk)
        return f"typed {typed} characters", {"typed": typed}
    if k == "paste":
        _check_stopped()
        _set_clipboard(action["text"])
        time.sleep(0.15)
        pg.hotkey("ctrl", "v")
        return f"pasted {len(action['text'])} characters", {"pasted": len(action["text"])}
    if k == "press":
        pg.press(action["key"])
        return f"pressed {action['key']}", {"pressed": action["key"]}
    if k == "hotkey":
        pg.hotkey(*action["keys"])
        return "pressed " + "+".join(action["keys"]), {"pressed": "+".join(action["keys"])}
    if k == "open_app":
        detail = _open_app(action["name"])
        return detail, {"app": action["name"]}
    waited = _sleep(action["seconds"])
    _check_stopped()
    return f"waited {waited}s", {"waited": waited}


class _Done(Exception):
    """Internal: the action was completed by a direct method; skip the remaining steps of execute()."""


APP_WORDS = {"chrome": ("chrome",), "msedge": ("edge", "msedge"), "firefox": ("firefox",), "notepad": ("notepad",), "calc": ("calculator", "calc"), "cmd": ("cmd", "command prompt", "terminal"), "code": ("vs code", "vscode", "visual studio", "code"), "explorer": ("file explorer", "explorer"), "mspaint": ("paint", "mspaint"), "taskmgr": ("task manager", "taskmgr"), "powershell": ("powershell",), "winword": ("word",), "excel": ("excel",), "whatsapp:": ("whatsapp",)}


def _named_apps(goal: str) -> list[str]:
    low = goal.lower()
    return [app for app, words in APP_WORDS.items() if any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", low) for w in words)]


def _guard_app(action: dict, goal: str) -> dict:
    """The brain must open what the user NAMED. If the step opens a different known app, it is corrected to the one in the instruction."""
    if action.get("type") not in ("open_app", "type") or not goal:
        return action
    key = "name" if action["type"] == "open_app" else "text"
    got = str(action.get(key, "")).strip().lower()
    if got not in APP_WORDS or got in _named_apps(goal):
        return action
    named = _named_apps(goal)
    if len(named) == 1:
        log.warning("guard: step wanted '%s' but the user named '%s': corrected", got, named[0])
        return {**action, key: named[0]}
    return action


def execute(action_id) -> dict:
    """Runs one planned action for real and returns what really happened (also remembered for the next plan)."""
    _check_stopped()
    while SESSION.paused.is_set() and not SESSION.stopped.is_set():  # Pause Actions: hold here, whatever route the action took
        time.sleep(0.05)
    _check_stopped()
    with SESSION.lock:
        entry = SESSION.pending.get(action_id) if isinstance(action_id, str) else None
        if entry is None or entry["used"]:
            raise RequestError(INVALID_PAYLOAD, "Unknown, expired or already executed action id.")
        if entry["needs_approval"] and not entry["approved"]:
            raise RequestError(APPROVAL_REQUIRED, "The user has not approved this action.")
        entry["used"] = True
        action = _guard_app(entry["action"], SESSION.goals[-1] if SESSION.goals else "")
        asked = entry["needs_approval"]
    label = describe(action)
    pg = _pg()
    started = time.monotonic()
    result = {"ok": False, "action": action, "describe": label}
    with SESSION.exec_lock:
        try:
            _check_stopped()
            if asked:
                _restore_focus()  # the Approve click took the keyboard away from the target app
            w, h = screen_size()  # re-check: the screen may have changed since planning
            if action["type"] == "click_on":  # the eye looks NOW and tells the hand where to click
                t_fs = time.monotonic()
                opened = _fs_open_target(action)
                if opened:  # direct API: done, no locating and no mouse
                    timed("execute.filesystem_open", t_fs)
                    result.update(ok=True, detail=opened + "; method=filesystem", data={"path": opened}, verified=True)
                    raise _Done()
                action = _locate(action)
                result["action"] = action
            if action["type"] in ("click", "move") and not (0 <= action["x"] < w and 0 <= action["y"] < h):
                raise RequestError(ACTION_INVALID, f"({action['x']}, {action['y']}) is outside the screen ({w}x{h}).")
            before = _snapshot()
            detail, data = _run(pg, action)
            note = _verify(action, before, detail, data)  # raises VERIFY_FAILED: an unconfirmed action is never reported as done
            result.update(ok=True, detail=f"{detail}; {note}", data=data, verified=True)
        except _Done:
            pass
        except RequestError as err:
            result.update(error={"code": err.code, "message": err.message})
        except Exception as err:  # noqa: BLE001
            if type(err).__name__ == "FailSafeException":
                SESSION.stopped.set()
                result.update(error={"code": HANDS_STOPPED, "message": "Stopped: the mouse was moved to a screen corner (PyAutoGUI fail-safe)."})
            else:
                log.exception("hands action failed")
                result.update(error={"code": ACTION_FAILED, "message": f"{type(err).__name__}: {err}"})
    with SESSION.lock:
        SESSION.pending.pop(action_id, None)
        if not result["ok"]:
            SESSION.failed[action_id] = action  # kept so the same action can be retried or replaced
            if len(SESSION.failed) > 30:
                SESSION.failed.pop(next(iter(SESSION.failed)))
    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    timed("execute." + str(label.split(" ")[0]).lower(), started)
    try:
        result["screen"] = dict(zip(("width", "height"), screen_size()))
    except RequestError:
        pass
    SESSION.record({"action": label, "ok": result["ok"], "detail": result.get("detail", ""), "error": result.get("error", {}).get("message", "")})
    with SESSION.lock:
        goal = SESSION.goals[-1] if SESSION.goals else ""
    brain.log_action(goal, label, result["ok"], result.get("detail", "") or result.get("error", {}).get("message", ""))
    if result["ok"]:
        brain.learn_from_action(action, goal)
    log.info("hands executed %s ok=%s", label, result["ok"])
    return result


def retry(action_id) -> dict:
    """Re-registers a FAILED action so it can be run again (same action, new id)."""
    _check_stopped()
    with SESSION.lock:
        action = SESSION.failed.get(action_id) if isinstance(action_id, str) else None
    if action is None:
        raise RequestError(INVALID_PAYLOAD, "Unknown action to retry.")
    return register(action, trusted=True)


RECOVER_PROMPT = (
    "You are the recovery planner for Windows Hands. A step FAILED. You cannot see the screen, except through the Live screen note in Background when given (it shows what is on screen now: use it to choose the different way). Find a DIFFERENT way to reach the same goal: "
    "do not repeat the failed step as it was. Use another route (Win+R box, another shortcut, another app name or launcher, waiting longer, "
    "typing a path). Include the failed step's purpose and ALL remaining steps needed to finish the goal, but not steps already done. "
    "Screen {w}x{h}. Actions: " + '{{"type":"open_app","name":"notepad"}} | {{"type":"type","text":"hi"}} (ASCII) | {{"type":"press","key":"enter"}} | '
    '{{"type":"hotkey","keys":["win","r"]}} | {{"type":"wait","seconds":1}} | {{"type":"click","x":100,"y":200,"button":"left","clicks":1}}. '
    'Reply with ONE JSON object only: {{"steps":[...],"say":"<only when no other route exists: why>"}}. At most {max} steps.'
)


def recover_start(goal, failed, error, done=None, attempt=1, action_id=None) -> dict:
    """Runs the rethink in the background (the model can take longer than one request may wait); read it with recover_result."""
    _check_stopped()
    jid = uuid.uuid4().hex[:12]
    job = {"state": "running", "out": None, "error": None}
    RECOVER_JOBS[jid] = job

    def work() -> None:
        try:
            job["out"] = recover(goal, failed, error, done, attempt, action_id)
        except RequestError as err:
            job["error"] = {"code": err.code, "message": err.message}
        except Exception as err:  # noqa: BLE001
            log.exception("recover failed")
            job["error"] = {"code": ACTION_FAILED, "message": f"{type(err).__name__}: {err}"}
        finally:
            job["state"] = "done"

    threading.Thread(target=work, daemon=True).start()
    return {"job": jid}


def recover_result(job_id) -> dict:
    job = RECOVER_JOBS.get(job_id) if isinstance(job_id, str) else None
    if job is None:
        raise RequestError(INVALID_PAYLOAD, "Unknown or expired rethink job.")
    if job["state"] == "running":
        return {"state": "running"}
    RECOVER_JOBS.pop(job_id, None)
    if job["error"]:
        return {"state": "error", "error": job["error"]}
    return {"state": "done", **job["out"]}


RECOVER_JOBS: dict[str, dict] = {}


# ---------- see-and-correct: after the steps ran, LOOK at the screen and fix what is wrong ----------
SEE_PROMPT = (
    "You check a Windows task by looking at this screenshot. Decide strictly whether the goal is fully achieved ON SCREEN "
    "(for example: text that had to be typed must be visible in the right window). If it is achieved, answer with exactly: DONE\n"
    "If not, answer with at most 4 corrective steps, one per line, nothing else:\n"
    "click <x> <y>   (x and y from 0 to 1000 over the screenshot: 0 0 is the top-left corner, 1000 1000 the bottom-right; click the centre of the target, e.g. the text area or button)\n"
    "type <text>\npress <key>\nkeys ctrl+s\napp <name>\nwait <seconds>\nsay <why it cannot be done>\n"
    "Do not repeat steps that already worked. Prefer a keyboard shortcut when there is one."
)
SEE_MAX_STEPS = 4


def see_check(goal, done=None) -> dict:
    """One look at the live screen. Returns {done, steps, say}: done=True when the goal is visibly achieved, otherwise validated and
    registered corrective steps (clicks are converted from the model's 0-1000 grid to real screen pixels)."""
    _check_stopped()
    if not isinstance(goal, str) or not goal.strip():
        raise RequestError(INVALID_PAYLOAD, "'goal' must be non-empty text.")
    if isinstance(done, list) and done:  # the always-on eye already knows which windows are open: an instant yes needs no model look
        hit = vision.goal_visible(goal)
        if hit:
            log.info("see_check: instant, window open: %s", hit)
            return {"done": True, "steps": [], "say": ""}
    shot = vision.fresh_jpeg()
    if shot is None:
        st = vision.status()
        raise RequestError(vision.VISION_UNAVAILABLE, (st.get("error") or {}).get("message") or "Live Vision is not available, so the screen could not be checked.")
    b64, _ = shot
    w, h = screen_size()
    pg = _pg()
    done = [str(d)[:120] for d in done[-12:]] if isinstance(done, list) else []
    user = f"Goal: {goal.strip()[:1000]}\nSteps already done:\n" + ("\n".join(f"- {d}" for d in done) or "- none")
    text = _ask_qwen([{"role": "system", "content": SEE_PROMPT}, {"role": "user", "content": user, "images": [b64]}], None, 220, vision.VISION_MODEL)
    lines = [ln.strip().strip("`").strip() for ln in (text or "").splitlines() if ln.strip()]
    if lines and lines[0].upper().startswith("DONE"):
        return {"done": True, "steps": [], "say": ""}
    steps, say = [], ""
    for ln in lines:
        cmd = ln.split(" ", 1)[0].lower().rstrip(":")
        if cmd == "click":
            nums = re.findall(r"\d+", ln)
            if len(nums) < 2:
                continue
            gx, gy = min(1000, int(nums[0])), min(1000, int(nums[1]))
            raw = {"type": "click", "x": round(gx / 1000 * (w - 1)), "y": round(gy / 1000 * (h - 1)), "button": "right" if "right" in ln.lower() else "left", "clicks": 2 if "double" in ln.lower() else 1}
        else:
            raw = parse_step_line(ln)
        if raw is None:
            continue
        if "type" not in raw:
            say = raw.get("say", "")[:300]
            continue
        if raw["type"] in fs_actions.FS_ACTIONS:
            continue  # the screen check only uses the keyboard and mouse
        try:
            action = normalize_action(raw, (w, h), pg.KEYBOARD_KEYS)
        except RequestError:
            continue
        if action["type"] == "type" and DESTRUCTIVE.search(action["text"]) and not WANTS_DESTRUCTIVE.search(goal):
            continue
        steps.append(register(action))
        if len(steps) >= SEE_MAX_STEPS:
            break
    return {"done": False, "steps": steps, "say": say or ("" if steps else "The screen does not show the goal and no fix was found.")}


def _fast_alternative(action: dict | None, attempt: int) -> list[dict] | None:
    """Instant, model-free other routes for the commonest failure (an app/folder that did not open). None = ask the brain instead."""
    if not action:
        return None
    k = action.get("type")
    if k == "open_app":
        name = action["name"]
        if attempt == 1:  # the Run box finds apps ShellExecute cannot
            return [{"type": "hotkey", "keys": ["win", "r"]}, {"type": "wait", "seconds": 0.6}, {"type": "type", "text": name}, {"type": "press", "key": "enter"}, {"type": "wait", "seconds": 2}]
        if attempt == 2:  # the Start menu search
            return [{"type": "press", "key": "win"}, {"type": "wait", "seconds": 0.8}, {"type": "type", "text": name}, {"type": "wait", "seconds": 1}, {"type": "press", "key": "enter"}, {"type": "wait", "seconds": 2}]
    if k == "click_on" and attempt <= 2:  # the target may simply not have appeared yet: look again after a short pause (no model plan)
        return [{"type": "wait", "seconds": 0.5 * attempt}, {k: v for k, v in action.items() if k not in ("id", "describe", "requires_approval")}]
    if k == "open_path" and attempt == 1 and action.get("path") and all(c not in action["path"] for c in '"&|<>^%'):
        return [{"type": "hotkey", "keys": ["win", "r"]}, {"type": "wait", "seconds": 0.6}, {"type": "type", "text": action["path"]}, {"type": "press", "key": "enter"}, {"type": "wait", "seconds": 1.5}]
    if k == "open_path" and action.get("app") == "code":  # VS Code would not open: Notepad / Explorer still show the work at once
        alt = {"type": "open_path", "app": "notepad", "path": action["path"], "file": action["file"]} if action.get("file") else {"type": "open_path", "app": "explorer", "path": action["path"]}
        if attempt >= 2:
            return [alt]
    return None


def recover(goal, failed, error, done=None, attempt=1, action_id=None) -> dict:
    """Rethink after a failed step: asks the brain for another approach and returns validated, registered steps."""
    _check_stopped()
    if not isinstance(goal, str) or not goal.strip():
        raise RequestError(INVALID_PAYLOAD, "'goal' must be non-empty text.")
    w, h = screen_size()
    pg = _pg()
    with SESSION.lock:
        failed_action = SESSION.failed.get(action_id) if isinstance(action_id, str) else None
    fast = _fast_alternative(failed_action, int(attempt) if isinstance(attempt, int) else 1)
    if fast:  # no model call: the other route is ready in milliseconds
        try:
            return {"steps": [register(normalize_action(a, (w, h), pg.KEYBOARD_KEYS)) for a in fast], "say": "", "fast": True}
        except RequestError:
            pass
    done = [str(d)[:120] for d in done[:12]] if isinstance(done, list) else []
    ctx = "\n".join(x for x in (brain.context(goal), brain.secrets_for(goal), vision.context()) if x)
    user = (
        (f"Background:\n{ctx}\n" if ctx else "")
        + f"Goal: {goal.strip()[:1500]}\nAlready done and verified (do not repeat):\n" + ("\n".join(f"- {d}" for d in done) or "- nothing")
        + f"\nFAILED step: {str(failed)[:300]}\nReal error: {str(error)[:400]}\nThis is recovery attempt {int(attempt)}: use a different approach than before."
    )
    system = RECOVER_PROMPT.format(w=w, h=h, max=MAX_PLAN_STEPS)
    text = _ask_qwen([{"role": "system", "content": system}, {"role": "user", "content": user}], None, 350, PLANNER_MODEL)  # a recovery plan is short: a small cap makes the model answer fast
    raw_steps, say = parse_steps(text)
    steps = []
    for raw in raw_steps[:MAX_PLAN_STEPS]:
        try:
            action = normalize_action(raw, (w, h), pg.KEYBOARD_KEYS, allow_fs=True)
        except RequestError as err:
            return {"steps": [], "say": f"The recovery plan was not valid: {err.message}"}
        if action["type"] == "type" and DESTRUCTIVE.search(action["text"]) and not WANTS_DESTRUCTIVE.search(goal):
            return {"steps": [], "say": "Blocked: the recovery plan contained a destructive command you did not ask for."}
        steps.append(register(action))
    return {"steps": steps, "say": "" if steps else (say or "No other approach found.")}
