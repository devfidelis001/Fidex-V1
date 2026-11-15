"""Fast planner: reads the whole instruction ONCE and, for known kinds of task, returns the COMPLETE ordered steps in
milliseconds with NO model call. Anything it does not fully understand returns None, and the normal model planner
(hands.ire_start) handles it exactly as before. The steps are executed by the local execution engine (hands.execute),
so approvals, Stop, failure handling and verification are unchanged.

Recipe: "create a folder <name> [on the desktop], open it in VS Code, create <empty file>". It never writes file content: that is the model's job.
Rule: the recipe must account for EVERYTHING the user asked. If a clause is left over that it cannot do, it steps aside.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

TASK_PREFIX = re.compile(r"^\s*task\s*:\s*", re.I)
FOLDER = re.compile(r"\b(?:create|make|new|add)\s+(?:a\s+|the\s+)?(?:new\s+)?folder\b(?:\s+(?:(?:called|named)\s+)?(?:[\"'\u201c]([A-Za-z0-9][A-Za-z0-9 ._\-]{0,59})[\"'\u201d]|([A-Za-z0-9][\w.\-]{0,59})))?", re.I)
PLACE = re.compile(r"\b(?:on|in|at|inside|under)\s+(?:the\s+|my\s+)?(desktop|documents|downloads)\b", re.I)
VSCODE = re.compile(r"\b(?:vs\s*code|vscode|visual\s+studio\s+code|(?:with|in|using|into)\s+code)\b", re.I)
OPEN_IT = re.compile(r"\bopen\s+(?:it|the\s+folder|that|this|the\s+project)?\s*(?:in|with|using|up\s+in)?\s*$|\bopen\b", re.I)
FILE = re.compile(r"\b([A-Za-z0-9][\w\-]{0,40}\.(?:html|css|js|txt|md|json|py))\b", re.I)
NAVBAR = re.compile(r"\b(?:nav\s*-?\s*bar|navigation(?:\s+(?:bar|menu))?|menu\s+bar)\b", re.I)
STOPNAMES = {"on", "in", "at", "for", "called", "named", "and", "then", "to", "with", "inside", "under", "it", "the", "a"}
LEFTOVER_VERBS = re.compile(r"\b(?:type|write|run|click|press|search|send|delete|remove|install|download|save|start|launch|play|navigate|go|git|commit|push|pull|rename|copy|move|paste|preview|serve|deploy|style|add|insert|put)\b", re.I)
FILLER = {"a", "an", "the", "simple", "basic", "new", "nice", "in", "it", "inside", "and", "then", "some", "that", "this", "of", "to", "with", "on", "my", "folder", "file", "called", "named", "create", "make", "open", "after", "also", "now", "please", "up", "using", "containing", "contain", "has", "have", "having", "include", "including", "which", "will", "be", "so", "i", "can", "see", "there", "inside"}



KIND_FILE = re.compile(r"\b(python|py|html|javascript|js|css|text|txt|markdown|json)\s+file\b", re.I)
KIND_NAME = {"python": "main.py", "py": "main.py", "html": "index.html", "javascript": "main.js", "js": "main.js", "css": "style.css", "text": "notes.txt", "txt": "notes.txt", "markdown": "README.md", "json": "data.json"}
CONTENT_WORDS = re.compile(r"\b(?:print|display|show|output|program|script|calculator|function|class|hello\s+world|write|content|inside)", re.I)
NOT_NAMES = STOPNAMES | {"open", "create", "make", "then", "launch", "start", "run", "new"}
DEFAULT_FOLDER = "New Folder"


SEP = re.compile(r"\s*(?:,|;|\band\s+then\b|\bthen\b|\band\b(?=\s+(?:open|launch|type|write|enter|click|double|right|press|wait|scroll|close|select|choose|pick|check|run|show)\b))\s*", re.I)
C_OPEN = re.compile(r"^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?([A-Za-z][\w .\-]{0,40}?)(?:\s+app)?$", re.I)
C_TYPE = re.compile(r"^(?:type|write|enter)\s+(?:\"(.+)\"|'(.+)'|\u201c(.+)\u201d|(.+))$", re.I)
C_CLICK = re.compile(r"^(?:(double|right)[\s-]*)?click(?:\s+(?:on|at))?\s+(?:the\s+)?(.+)$", re.I)
C_CLOSE = re.compile(r"^close(?:\s+(?:it|this|that|the\s+[\w ]+?|[\w]+))?(?:\s+(?:in|with|using|by\s+clicking|by\s+using|via)\s+(?:the\s+)?(.+))?$", re.I)
C_OPENFOLDER = re.compile(r"^(?:please\s+)?open\s+(?:the\s+)?(?:folder\s+)?([A-Za-z0-9][\w.\-]{0,59})\s+folder(?:\s+(?:on|in|at)\s+(?:the\s+|my\s+)?(desktop|documents|downloads))?$", re.I)
ORD = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6}
PROFILE_ORD = re.compile(r"\b(first|second|third|fourth|fifth|sixth|\d+)(?:st|nd|rd|th)?\s+(?:user\s+)?(?:account|profile|user)\b", re.I)


def chrome_profile_dir(n: int) -> str | None:
    """The folder name of Chrome's n-th profile (Default, Profile 1, ...), read from Chrome's own Local State file. None if unreadable."""
    import json
    import os

    try:
        st = json.loads((Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data" / "Local State").read_text(encoding="utf-8"))
        names = list(st["profile"]["info_cache"].keys())
    except Exception:  # noqa: BLE001
        return None
    names.sort(key=lambda x: (0, 0) if x == "Default" else (1, int(re.sub(r"\D", "", x) or 99)))
    return names[n - 1] if 1 <= n <= len(names) else None


URLISH = re.compile(r"^(?:https?://)?(?:www\.)?[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:/\S*)?$", re.I)
C_SELECT = re.compile(r"^(?:select|choose|pick)\s+(?:the\s+)?(.+)$", re.I)
C_VERSION = re.compile(r"^(?:check|show|get|see|find|tell\s+me)\s+(?:me\s+)?(?:the\s+)?(python|node|npm|git|pip|java)(?:\s+(?:version|-?-?v(?:ersion)?))(?:\s+(?:in|on|with|using)\s+(?:the\s+)?(?:cmd|command\s+prompt|terminal))?$", re.I)
C_RUNCMD = re.compile(r"^run\s+(?:the\s+command\s+)?([\w.\-]+(?:\s+[\w.\-:\\/]+){0,6}?)(?:\s+(?:in|on|with|using)\s+(?:the\s+)?(?:cmd|command\s+prompt|terminal))?$", re.I)
C_WAITME = re.compile(r"^(?:wait|hold\s+on|pause|stop)(?:\s+(?:and\s+wait\s+)?(?:for\s+me|until\s+i\s+(?:say|tell)(?:\s+you)?|till\s+i\s+(?:say|tell)(?:\s+you)?))?$", re.I)
VERSION_CMDS = {"python": ["python --version", "py --version", "python3 --version"], "node": ["node --version"], "npm": ["npm --version"], "git": ["git --version"], "pip": ["pip --version", "py -m pip --version"], "java": ["java -version"]}
C_SCROLL = re.compile(r"^scroll\s+(up|down)(?:\s+(?:by\s+)?(\d{1,4}))?$", re.I)
C_WAIT = re.compile(r"^wait\s+(?:for\s+)?(\d+(?:\.\d+)?)", re.I)
C_PRESS = re.compile(r"^(?:press|hit)\s+(?:the\s+)?(.+?)(?:\s+key)?$", re.I)
OPEN_ALIAS = {"vs code": "code", "vscode": "code", "visual studio code": "code", "google chrome": "chrome", "microsoft edge": "msedge", "edge": "msedge", "command prompt": "cmd", "file explorer": "explorer", "task manager": "taskmgr", "paint": "mspaint", "calculator": "calc"}


def ui_plan(instruction: str, resolver: Callable[[str], Path] | None = None) -> dict | None:
    """Rule-based plan for open / type / click / press / wait commands, understood clause by clause. EVERY clause must be understood,
    otherwise None (the model planner takes over). Every click is a click_on: the eye (Live Vision) finds the target on the live screen
    when the step runs and the hand clicks it, so no model has to guess coordinates."""
    text = TASK_PREFIX.sub("", instruction or "").strip()[:1500].rstrip(" .!")
    if not text:
        return None
    clauses = [c.strip() for c in SEP.split(text) if c and c.strip()]
    steps: list[dict] = []
    mouse = bool(re.search(r"\b(?:use|using|with)\s+(?:the\s+|your\s+)?mouse\b", text, re.I))
    for c in clauses:
        c = re.sub(r"^(?:and|then|also|now|please)\s+", "", c, flags=re.I).strip()
        if re.match(r"^(?:use|using|with)\s+(?:the\s+|your\s+)?mouse$", c, re.I):
            continue  # a style instruction, not a step: it makes close use the mouse
        m = C_CLOSE.match(c)
        if m and (mouse or re.search(r"\b(?:button|x|mouse)\b", c, re.I)) and not m.group(1):
            steps.append({"type": "click_on", "target": c[:120], "button": "left", "clicks": 1})
            steps.append({"type": "wait", "seconds": 0.25})
            continue
        if C_WAITME.match(c) and re.search(r"me|until|till|hold|pause|stop", c, re.I) and not C_WAIT.match(c):
            steps.append({"type": "wait_user", "message": "Waiting for you. Tell me when to continue."})
            continue
        m = C_VERSION.match(c)
        if m:
            steps.append({"type": "run_cmd", "command": VERSION_CMDS[m.group(1).lower()][0], "alts": VERSION_CMDS[m.group(1).lower()][1:]})
            continue
        m = C_SELECT.match(c)
        if m:  # "select the second user account": the eye finds it on the live screen; after Chrome opens it is the profile picker
            target = m.group(1).strip().strip("\"'\u201c\u201d")[:100]
            mo = PROFILE_ORD.search(target)
            if mo and any(s_.get("type") == "type" and s_.get("text") == "chrome" for s_ in steps):  # exact: start Chrome WITH that profile, no clicking
                n = ORD.get(mo.group(1).lower()) or int(mo.group(1))
                pdir = chrome_profile_dir(n)
                if pdir:
                    for s_ in steps:
                        if s_.get("type") == "type" and s_.get("text") == "chrome":
                            s_["text"] = f'chrome --profile-directory="{pdir}"'
                    continue
            after_chrome = any(s_.get("type") == "type" and s_.get("text") in ("chrome", "msedge") for s_ in steps)
            if after_chrome and re.search(r"account|profile|user", target, re.I):
                target += " in the Chrome profile picker"
            steps.append({"type": "click_on", "target": target, "button": "left", "clicks": 1})
            steps.append({"type": "wait", "seconds": 0.25})
            continue
        m = C_CLICK.match(c)
        if m:
            target = m.group(2).strip().strip("\"'\u201c\u201d")
            if re.fullmatch(r"\(?\s*\d+\s*[, ]\s*\d+\s*\)?", target) or len(target) < 1:
                return None
            mod = (m.group(1) or "").lower()
            steps.append({"type": "click_on", "target": target[:120], "button": "right" if mod == "right" else "left", "clicks": 2 if mod == "double" else 1})
            steps.append({"type": "wait", "seconds": 0.25})  # the screen reacts (a dialog appears): the next look must see it
            continue
        m = C_CLOSE.match(c)
        if m:
            if m.group(1):  # "close it in the top right x button": the eye finds that button and the hand clicks it
                steps.append({"type": "click_on", "target": m.group(1).strip()[:120], "button": "left", "clicks": 1})
                steps.append({"type": "wait", "seconds": 0.25})
            else:
                steps.append({"type": "hotkey", "keys": ["alt", "f4"]})
                steps.append({"type": "wait", "seconds": 0.25})
            continue
        m = C_TYPE.match(c)
        if m:
            t = next((g for g in m.groups() if g), "")
            if not t:
                return None
            if URLISH.match(t.strip()) and any(s_.get("type") == "type" and str(s_.get("text", "")).startswith(("chrome", "msedge", "firefox")) for s_ in steps):
                steps += [{"type": "wait", "seconds": 1.5}, {"type": "hotkey", "keys": ["ctrl", "l"]}, {"type": "type", "text": t.strip()}, {"type": "press", "key": "enter"}]  # address bar, then go
                continue
            steps.append({"type": "type", "text": t})
            continue
        m = C_WAIT.match(c)
        if m:
            steps.append({"type": "wait", "seconds": min(10.0, float(m.group(1)))})
            continue
        m = C_SCROLL.match(c)
        if m:
            n = int(m.group(2)) if m.group(2) else 300
            steps.append({"type": "scroll", "amount": n if m.group(1).lower() == "up" else -n})
            continue
        m = C_PRESS.match(c)
        if m:
            key = re.sub(r"\s*(?:\+|plus)\s*", "+", m.group(1).strip().lower())
            parts = [p for p in key.split("+") if p]
            if not parts or " " in key:
                return None
            steps.append({"type": "hotkey", "keys": parts} if len(parts) > 1 else {"type": "press", "key": parts[0]})
            continue
        m = C_RUNCMD.match(c)
        if m and not re.search(r"\b(delete|remove|format|shutdown)\b", m.group(1), re.I) and re.match(r"(?:python|py|node|npm|git|pip|dir|cd|ipconfig|ping|where|echo|code|java|tree|whoami|hostname|systeminfo|ver)\b", m.group(1), re.I):
            steps.append({"type": "run_cmd", "command": m.group(1).strip()})
            continue
        m = C_OPENFOLDER.match(c)
        if m:  # direct filesystem open (Explorer on the path): no icon to find, no mouse
            base = resolver(m.group(2).lower()) if m.group(2) else None
            if base is not None:
                steps.append({"type": "open_path", "app": "explorer", "path": str(base / m.group(1).strip())})
                continue
        m = C_OPEN.match(c)
        if m:
            name = m.group(1).strip()
            if re.search(r"\b(?:folder|file|website|site|page|link|it|that|this|and|then|play|search|go|type|write|click|press)\b", name, re.I):
                return None
            nm = OPEN_ALIAS.get(name.lower(), name)
            if nm.lower() in ("chrome", "msedge", "firefox"):  # browsers: Win+R, type the name, Enter (the proper way)
                steps += [{"type": "hotkey", "keys": ["win", "r"]}, {"type": "wait", "seconds": 0.6}, {"type": "type", "text": nm.lower()}, {"type": "press", "key": "enter"}, {"type": "wait", "seconds": 3}]
            else:
                steps.append({"type": "open_app", "name": nm})
            continue
        return None  # a clause that is not understood: never guess
    steps = [s_ for i, s_ in enumerate(steps) if not (s_.get("type") == "open_app" and s_.get("name") == "cmd" and i + 1 < len(steps) and steps[i + 1].get("type") == "run_cmd")]
    while steps and steps[-1]["type"] == "wait":  # nothing follows the last step: do not wait for it
        steps.pop()
    if not steps or not any(s["type"] == "click_on" for s in steps) and len(steps) < 2:
        return None if not steps else {"steps": steps, "say": f"Planned {len(steps)} steps instantly, no model needed."}
    return {"steps": steps, "say": f"Planned {len(steps)} steps instantly, no model needed."}


def compile_plan(instruction: str, resolve_folder: Callable[[str], Path]) -> dict | None:
    """Returns {"steps": [raw actions], "say": str} or None when this is not a task the recipe fully understands.
    A plan with no steps and a "say" means: understood, but one fact is missing (asked at once instead of guessing)."""
    if not isinstance(instruction, str):
        return None
    text = TASK_PREFIX.sub("", instruction).strip()[:2000]
    m = FOLDER.search(text)
    if not m:
        return ui_plan(instruction, resolve_folder)
    name = (m.group(1) or m.group(2) or "").strip()
    spans = [m.span()]
    if not name or name.lower() in NOT_NAMES:  # "create new folder open with code ..." has no name: the second word is not one
        name = DEFAULT_FOLDER
        spans = [(m.start(), m.start() + re.search(r"folder", text[m.start():], re.I).end())]
    where = PLACE.search(text)
    if where:
        spans.append(where.span())
    base = resolve_folder((where.group(1) if where else "desktop").lower())
    folder = base / name

    files = list(FILE.finditer(text))
    if len(files) > 1:
        return None
    fname = files[0].group(1) if files else None
    if files:
        spans.append(files[0].span())
    else:
        kf = KIND_FILE.search(text)
        if kf:
            fname = KIND_NAME[kf.group(1).lower()]
            spans.append(kf.span())
        elif re.search(r"\b(?:a|the)\s+file\b", text, re.I):
            return None
    editor = VSCODE.search(text)
    if editor:
        spans.append(editor.span())
    elif re.search(r"\bopen\b", text, re.I):
        return None  # opened in something other than VS Code: let the model decide

    content = ""  # file CONTENT is never canned: any request to write something (code, navbar, text) is left to the model planner
    if NAVBAR.search(text) or CONTENT_WORDS.search(text):
        return None
    # everything the user said must be accounted for: blank out what was understood, then look at what is left
    rest = list(text)
    for a, b in spans:
        for i in range(a, b):
            rest[i] = " "
    leftover = "".join(rest)
    if LEFTOVER_VERBS.search(leftover):
        return None
    words = [w for w in re.findall(r"[A-Za-z]+", leftover.lower()) if w not in FILLER and w not in {"desktop", "documents", "downloads", "navbar", "nav", "bar", "navigation", "menu", "vs", "code", "visual", "studio", "vscode", "folder", "python", "file", "then", "and"}]
    if words:
        return None

    steps: list[dict] = [{"type": "make_dir", "path": str(folder)}]
    if fname:
        steps.append({"type": "write_file", "path": str(folder / fname), "content": content})
    if editor:
        step: dict = {"type": "open_path", "app": "code", "path": str(folder)}
        if fname:
            step["file"] = str(folder / fname)
        steps.append(step)
    return {"steps": steps, "say": f"Planned {len(steps)} steps instantly, no model needed."}
