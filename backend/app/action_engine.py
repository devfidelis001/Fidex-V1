"""Action Decision Engine: decides whether an instruction needs an action, picks the tool, extracts its parameters,
executes it through the existing Hands handlers and returns the REAL result to Qwen.

    decide(instruction) -> {needs_action, source, tool, params, say, action, done, reason}
        1. recognise: plain conversation never reaches Hands (needs_action False -> normal chat).
        2. select + extract: clear commands are parsed by rules (fast, no model); anything else actionable is
           planned by Qwen through the existing hands.plan.
        3. the chosen action is validated and registered as pending exactly like a Qwen plan (hands.propose).
    run(action_id, approved) -> {ok, declined, result, reply}
        approves/declines and executes only through HANDLERS["hands.approve"] / ["hands.execute"], so the existing
        approval, Stop and fail-safe checks always apply. The real result is then given to Qwen for the user-facing reply.
Nothing here executes anything by itself and nothing can skip approval.
"""
from __future__ import annotations

import json
import logging
import os
import re

from . import hands
from .protocol import INVALID_PAYLOAD, RequestError

log = logging.getLogger("fidex.action")

DEFAULT_SCROLL = 300
APP_ALIASES = {"calculator": "calc", "paint": "mspaint", "file explorer": "explorer", "explorer": "explorer", "command prompt": "cmd", "task manager": "taskmgr", "google chrome": "chrome", "microsoft edge": "msedge", "edge": "msedge"}
POLITE = re.compile(r"^(?:(?:hey|ok|okay)\s+)?(?:(?:can|could|would|will)\s+you\s+|please\s+|i\s+(?:want|need)\s+you\s+to\s+|i(?:'d| would)\s+like\s+you\s+to\s+)+", re.I)
QUESTION_START = re.compile(r"^(?:what|why|how|who|whom|whose|when|where|which|is|are|was|were|do|does|did|explain|tell|define|describe|summari[sz]e|translate|list|give|show)\b", re.I)
ACTION_WORDS = re.compile(r"\b(?:open|launch|start|run|type|press|hit|click|double-?click|right-?click|move|scroll|wait|close|save|copy|paste|select|minimi[sz]e|maximi[sz]e|switch|create|take over|control|search|google|message|send|build|browse|visit|navigate|play|download|install|delete|rename|find|look up|go to|draft|compose)\b", re.I)
SCREEN_MARGIN = 10  # PyAutoGUI's fail-safe aborts at the exact screen corners, so "corner" targets stay a few pixels inside
NUM = r"(\d{1,5})"
XY = rf"\(?\s*{NUM}\s*[, ]\s*{NUM}\s*\)?"

POINTER = r"(?:the\s+)?(?:mouse(?:\s+(?:pointer|cursor))?|cursor|pointer)"
RULES = [
    ("click_pos", re.compile(r"^(left\s+|right\s+|middle\s+|double[\s-]*)?click\s+(?:(?:at|on|in|into)\s+)?(.+)$", re.I)),
    ("move_pos", re.compile(rf"^(?:move|put|place|bring|take|send|drag|go)\s+{POINTER}\s*(?:(?:over\s+)?(?:to|at|in|into|onto)\s+)?(.+)$", re.I)),
    ("click", re.compile(rf"^(left\s+|right\s+|middle\s+|double[\s-]*)?click(?:\s+(?:at|on))?\s*{XY}$", re.I)),
    ("move", re.compile(rf"^move\s+(?:the\s+)?(?:mouse|cursor|pointer)?\s*(?:to\s+)?{XY}$", re.I)),
    ("scroll", re.compile(r"^scroll\s+(up|down)(?:\s+(?:by\s+)?(\d{1,4}))?$", re.I)),
    ("wait", re.compile(r"^wait\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)?$", re.I)),
    ("type", re.compile(r"^(?:type|enter|write)\s+(?:\"(.+)\"|'(.+)'|\u201c(.+)\u201d)(?:\s+(?:in|into)\s+.+)?$", re.I | re.S)),
    ("type", re.compile(r"^type\s+(.+)$", re.I | re.S)),
    ("press", re.compile(r"^(?:press|hit)\s+(?:the\s+)?(.+?)(?:\s+key)?$", re.I)),
    ("combo", re.compile(r"^(?:[a-z ]{0,30}?\b)?((?:ctrl|control|alt|shift|win|windows)\s*(?:\+|plus)\s*[a-z0-9]+(?:\s*(?:\+|plus)\s*[a-z0-9]+){0,2})(?:\s+(?:keys?|shortcut))?$", re.I)),
    ("save", re.compile(r"^(?:save|save\s+(?:it|this|that|the\s+file|the\s+document|the\s+doc|file))$", re.I)),
    ("open_app", re.compile(r"^(?:open|launch|start|run)\s+(?!(?:it|this|that|them)\b)(?:the\s+)?(?:app\s+|application\s+|program\s+)?([A-Za-z0-9][A-Za-z0-9 ._\-]{0,59}?)(?:\s+(?:app|application|program))?(?:\s*,?\s+(?:and\s+then|and|then)\s+.+)?$", re.I | re.S)),
]


def resolve_position(text: str, size: tuple[int, int]) -> tuple[int, int] | None:
    """Turns a screen-relative place ("the centre", "top left corner", "bottom of the screen", "50% 25%") into pixel
    coordinates for THIS screen. None when the text is not such a place."""
    t = re.sub(r"\b(?:the|of|on|in|screen|display|monitor|desktop|corner|edge|side|part|area)\b", " ", text.lower().replace("-", " "))
    t = re.sub(r"[^a-z0-9% ]", " ", t).split()
    w, h = size
    m = re.fullmatch(r"(\d{1,3})%?\s+(\d{1,3})%", " ".join(t)) or re.fullmatch(r"(\d{1,3})%\s+(\d{1,3})%?", " ".join(t))
    if m:
        fx, fy = int(m.group(1)) / 100, int(m.group(2)) / 100
    else:
        words = {"top": "t", "upper": "t", "bottom": "b", "lower": "b", "left": "l", "right": "r", "centre": "c", "center": "c", "middle": "c"}
        if not t or any(x not in words for x in t):
            return None
        kinds = {words[x] for x in t}
        if ("t" in kinds and "b" in kinds) or ("l" in kinds and "r" in kinds):
            return None
        fx = 0.0 if "l" in kinds else 1.0 if "r" in kinds else 0.5
        fy = 0.0 if "t" in kinds else 1.0 if "b" in kinds else 0.5
    if not (0 <= fx <= 1 and 0 <= fy <= 1):
        return None
    lo_x, hi_x, lo_y, hi_y = SCREEN_MARGIN, w - 1 - SCREEN_MARGIN, SCREEN_MARGIN, h - 1 - SCREEN_MARGIN
    x = round(fx * (w - 1)) if fx == 0.5 else min(max(round(fx * (w - 1)), lo_x), max(lo_x, hi_x))
    y = round(fy * (h - 1)) if fy == 0.5 else min(max(round(fy * (h - 1)), lo_y), max(lo_y, hi_y))
    return x, y


TASK_LABEL = re.compile(r"^task\s*:\s*", re.I)  # Take Over submits a new task as "Task: <text>"


def _strip(text: str) -> tuple[str, bool]:
    t = TASK_LABEL.sub("", text.strip(), count=1).strip()
    had_polite = bool(POLITE.match(t))
    t = POLITE.sub("", t).strip()
    t = re.sub(r"[\s.!?]+$", "", t) if had_polite else t.rstrip(" .!") if not re.search(r"[\"'\u201d]$", t) else t
    t = re.sub(r"\s+please$", "", t, flags=re.I)
    return t, had_polite


def recognise(instruction: str) -> bool:
    """True when the instruction may need an action. Plain questions/conversation return False."""
    t, polite = _strip(instruction)
    if TASK_LABEL.match(instruction.strip()) and not instruction.strip().endswith("?"):
        return True  # Take Over labels every new task: it is always something to do
    if any(rx.match(t) for kind, rx in RULES if kind not in ("click_pos",)):
        return True
    if not polite and (QUESTION_START.match(t) or instruction.strip().endswith("?")):
        return False
    return bool(ACTION_WORDS.search(t))


def parse_rule(instruction: str) -> dict | None:
    """Select the tool and extract its parameters from a clear command. None when no rule fits."""
    t, _ = _strip(instruction)
    for kind, rx in RULES:
        m = rx.match(t)
        if not m:
            continue
        g = m.groups()
        if kind in ("click_pos", "move_pos"):
            pos = resolve_position(g[-1], hands.screen_size())
            if pos is None:
                continue  # not a screen position (e.g. "click save"): leave it to the Qwen planner
            if kind == "move_pos":
                return {"type": "move", "x": pos[0], "y": pos[1]}
            mod = (g[0] or "").strip().lower().rstrip("-")
            return {"type": "click", "x": pos[0], "y": pos[1], "button": mod if mod in ("left", "right", "middle") else "left", "clicks": 2 if mod.startswith("double") else 1}
        if kind == "click":
            mod = (g[0] or "").strip().lower().rstrip("-")
            return {"type": "click", "x": int(g[1]), "y": int(g[2]), "button": mod if mod in ("left", "right", "middle") else "left", "clicks": 2 if mod.startswith("double") else 1}
        if kind == "move":
            return {"type": "move", "x": int(g[0]), "y": int(g[1])}
        if kind == "scroll":
            n = int(g[1]) if g[1] else DEFAULT_SCROLL
            return {"type": "scroll", "amount": n if g[0].lower() == "up" else -n}
        if kind == "combo":
            return {"type": "hotkey", "keys": [k.strip() for k in re.split(r"\s*(?:\+|plus)\s*", g[0].lower()) if k.strip()]}
        if kind == "save":
            return {"type": "hotkey", "keys": ["ctrl", "s"]}
        if kind == "wait":
            return {"type": "wait", "seconds": float(g[0])}
        if kind == "type":
            text = next((x for x in g if x), "")
            return {"type": "type", "text": text}
        if kind == "press":
            key = g[0].strip()
            parts = key.lower().split()
            if " plus " in key.lower():
                key = key.lower().replace(" plus ", "+").replace(" ", "")
            elif len(parts) > 1 and parts[0] in ("ctrl", "control", "alt", "shift", "win", "windows"):
                key = "+".join(parts)
            return {"type": "press", "key": key}
        name = g[0].strip()
        return {"type": "open_app", "name": APP_ALIASES.get(name.lower(), name)}
    return None


def _result(**kw) -> dict:
    base = {"needs_action": False, "source": "none", "tool": None, "params": None, "say": "", "action": None, "done": False, "reason": ""}
    base.update(kw)
    return base


def decide(instruction, rules_only: bool = False) -> dict:
    """Decides what to do with one user instruction. Never executes."""
    from .handlers import HANDLERS  # noqa: PLC0415  (handlers imports this module's handlers at the bottom)

    if not isinstance(instruction, str) or not instruction.strip():
        raise RequestError(INVALID_PAYLOAD, "'instruction' must be non-empty text.")
    instruction = instruction.strip()[:2000]
    if not recognise(instruction):
        return _result(reason="conversation: no action needed")
    raw = parse_rule(instruction)
    if raw is None and rules_only:  # used for fast multi-step commands: never wait for the model here
        return _result(source="unparsed", reason="not a clear command")
    if raw is not None:
        try:
            action = hands.propose(raw, instruction, trusted=True)  # the user typed this command: no extra Approve click
        except RequestError as err:
            if err.code in (hands.ACTION_INVALID,):
                return _result(needs_action=True, source="rules", say=f"I cannot do that: {err.message}", reason="invalid parameters", tool="hands." + raw["type"], params=raw)
            raise
        return _result(needs_action=True, source="rules", tool="hands." + action["type"], params={k: v for k, v in action.items() if k not in ("id", "describe", "requires_approval")}, say=f"I can {action['describe']}.", action=action, reason="clear command")
    planned = HANDLERS["hands.plan"]({"instruction": instruction})  # Qwen selects the tool/parameters; same validation as before
    action = planned.get("action")
    return _result(needs_action=action is not None, source="qwen", tool=("hands." + action["type"]) if action else None, params={k: v for k, v in action.items() if k not in ("id", "describe", "requires_approval")} if action else None, say=planned.get("say", ""), action=action, done=bool(planned.get("done")), last=bool(planned.get("last")), reason="planned by Qwen" if action else "Qwen found no action")


REPORT_WITH_MODEL = os.environ.get("FIDEX_REPORT_WITH_MODEL") == "1"
REPORT_PROMPT = (
    "You are FIDEX AI. Tell the user in one or two short plain sentences what just happened, using ONLY the real result below. "
    "Never say it worked unless ok is true. If it failed or was declined, say so and what they can do. No markdown."
)


def _fallback_reply(result: dict) -> str:
    if result.get("declined"):
        return f"Declined: {result.get('describe', 'the action')}. Nothing was done."
    if result.get("ok"):
        return f"Done: {result.get('describe', 'the action')}. {result.get('detail', '')}".strip()
    err = result.get("error") or {}
    return f"Failed: {result.get('describe', 'the action')}. {err.get('message', 'Unknown error.')}".strip()


def report(result: dict) -> str:
    """Gives the real result back to Qwen for the user-facing answer. Falls back to a plain sentence if Qwen is unavailable."""
    if not REPORT_WITH_MODEL:  # the real result already says what happened: no model call after every action
        return _fallback_reply(result)
    with hands.SESSION.lock:
        goal = hands.SESSION.goals[-1] if hands.SESSION.goals else ""
    brief = {k: result.get(k) for k in ("ok", "declined", "describe", "detail", "error") if result.get(k) not in (None, "")}
    try:
        text = hands._ask_qwen([{"role": "system", "content": REPORT_PROMPT}, {"role": "user", "content": f"User asked: {goal}\nReal result: {json.dumps(brief)}"}])
        text = (text or "").strip()
        return text[:600] if text else _fallback_reply(result)
    except RequestError as err:
        if err.code == hands.HANDS_STOPPED:
            raise
        return _fallback_reply(result)
    except Exception:  # noqa: BLE001
        log.exception("action report failed")
        return _fallback_reply(result)


def run(action_id, approved) -> dict:
    """Approve/decline then execute through the existing Hands handlers. Their approval and Stop checks are the only gate."""
    from .handlers import HANDLERS  # noqa: PLC0415

    if not isinstance(approved, bool):
        raise RequestError(INVALID_PAYLOAD, "'approved' must be true or false.")
    with hands.SESSION.lock:
        entry = hands.SESSION.pending.get(action_id) if isinstance(action_id, str) else None
        label = hands.describe(entry["action"]) if entry else ""
    HANDLERS["hands.approve"]({"action_id": action_id, "approved": approved})
    if not approved:
        result = {"ok": False, "declined": True, "describe": label}
    else:
        result = HANDLERS["hands.execute"]({"action_id": action_id})
    return {"ok": bool(result.get("ok")), "declined": bool(result.get("declined")), "result": result, "reply": report(result)}
