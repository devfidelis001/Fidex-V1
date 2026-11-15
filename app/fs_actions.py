"""Local file actions for Hands: make a folder, write a file, open a folder/file in VS Code.

These run directly in the backend (no keyboard guessing, no model), so a task such as "make a folder, put index.html in it
and open it in VS Code" takes milliseconds and cannot be broken by a slow app or a focus change. They go through the SAME
gate as every other action: hands.register -> hands.approve -> hands.execute, with Stop checks and a real result.

Safety: every path must be inside the user's own folder, names are strict, nothing is overwritten, and no shell is used.
The model planner (hands.ire_start) may create these actions; every path is validated against the user folder.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from .protocol import RequestError

ACTION_INVALID = "ACTION_INVALID"  # same codes as hands.py (plain strings, so there is no import cycle)
ACTION_FAILED = "ACTION_FAILED"

FS_ACTIONS = ("make_dir", "write_file", "open_path", "edit_file", "run_cmd", "wait_user")
NO_WINDOW_CHECK = ("make_dir", "write_file", "edit_file", "run_cmd", "wait_user")
DESTRUCTIVE_CMD = re.compile(r"\b(format\s+[a-z]:|shutdown|rmdir\s+/s|rd\s+/s|del\s+/[sfq]|remove-item|rm\s+-rf|diskpart|reg\s+delete|cipher\s+/w)", re.I)
LAST_PROJECT: list = [None]  # the folder the user is working on: the next task continues in it instead of starting a new one
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,59}$")
BAD_CHARS = set('"&|<>^%*?\r\n\t\x00')  # cmd.exe metacharacters / wildcards: a path containing one is refused
RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
FILE_EXT = {".html", ".css", ".js", ".ts", ".py", ".java", ".c", ".cpp", ".go", ".rs", ".php", ".rb", ".sh", ".txt", ".md", ".json"}
MAX_CONTENT = 20000
OPEN_WITH = ("notepad", "explorer", "code")


def root() -> Path:
    """The only place these actions may touch: the user's own folder (FIDEX_FS_ROOT overrides it, e.g. for tests)."""
    return Path(os.environ.get("FIDEX_FS_ROOT") or Path.home()).resolve()


def known_folder(name: str) -> Path:
    """Desktop / Documents / Downloads of this user (follows OneDrive redirection on Windows)."""
    cands: list[Path] = []
    if sys.platform == "win32":
        try:
            import ctypes  # noqa: PLC0415

            csidl = {"desktop": 0x10, "documents": 0x05}.get(name)
            if csidl is not None:
                buf = ctypes.create_unicode_buffer(260)
                if ctypes.windll.shell32.SHGetFolderPathW(None, csidl, None, 0, buf) == 0 and buf.value:  # type: ignore[attr-defined]
                    cands.append(Path(buf.value))
        except Exception:  # noqa: BLE001
            pass
    base = Path(os.environ.get("FIDEX_FS_ROOT") or Path.home())
    cands.append(base / name.capitalize())
    for c in cands:
        if c.is_dir():
            return c
    return base / name.capitalize()


def _invalid(msg: str) -> RequestError:
    return RequestError(ACTION_INVALID, msg)


def _path(value, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(f"'{label}' must be a path.")
    if any(c in BAD_CHARS for c in value):
        raise _invalid(f"'{label}' contains a character that is not allowed.")
    value = value.strip().replace("\\", "/")
    low = value.lower()
    for folder in ("desktop", "documents", "downloads"):  # short forms the planner writes: desktop/name/file.txt
        if low == folder or low.startswith(folder + "/"):
            value = str(known_folder(folder) / value[len(folder):].lstrip("/"))
            break
    p = Path(value)
    if not p.is_absolute():
        p = known_folder("desktop") / value  # a bare name means "on the Desktop"
    try:
        rp = p.resolve()
    except (OSError, RuntimeError):
        raise _invalid(f"'{label}' is not a usable path.") from None
    r = root()
    if rp == r or r not in rp.parents:
        raise _invalid(f"'{label}' must be inside your user folder ({r}).")
    if not NAME_RE.match(rp.name) or rp.name.endswith((".", " ")) or rp.stem.lower() in RESERVED:
        raise _invalid(f"'{rp.name}' is not an allowed name (letters, digits, space, . _ - only).")
    return rp


def normalize(raw: dict) -> dict:
    kind = raw["type"]
    if kind == "wait_user":
        return {"type": kind, "message": str(raw.get("message") or "Waiting for you. Tell me when to continue.").strip()[:200]}
    if kind == "run_cmd":
        cmds = [str(c).strip() for c in [raw.get("command")] + list(raw.get("alts") or []) if isinstance(c, str) and c.strip()]
        if not cmds or any(len(c) > 300 or "\n" in c or "\r" in c for c in cmds):
            raise _invalid("'command' must be one line of at most 300 characters.")
        if any(DESTRUCTIVE_CMD.search(c) for c in cmds):
            raise _invalid("Blocked: that command is destructive.")
        out = {"type": kind, "command": cmds[0], "alts": cmds[1:4]}
        if raw.get("cwd"):
            out["cwd"] = str(_path(raw.get("cwd"), "cwd"))
        return out
    if kind == "edit_file":
        p = _path(raw.get("path"), "path")
        if p.suffix.lower() not in FILE_EXT:
            raise _invalid("Allowed file types: " + ", ".join(sorted(FILE_EXT)) + ".")
        mode = raw.get("mode", "append")
        if mode not in ("append", "after", "before"):
            raise _invalid("'mode' must be append, after or before.")
        text = raw.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_CONTENT:
            raise _invalid("'text' must be the text to add.")
        anchor = str(raw.get("anchor") or "").strip()
        if mode != "append" and not anchor:
            raise _invalid("'anchor' is needed for after/before.")
        return {"type": kind, "path": str(p), "mode": mode, "anchor": anchor[:200], "text": text}
    if kind == "make_dir":
        return {"type": kind, "path": str(_path(raw.get("path"), "path"))}
    if kind == "write_file":
        p = _path(raw.get("path"), "path")
        if p.suffix.lower() not in FILE_EXT:
            raise _invalid("Allowed file types: " + ", ".join(sorted(FILE_EXT)) + ".")
        content = raw.get("content")
        if not isinstance(content, str):
            raise _invalid("'content' must be text.")
        if len(content) > MAX_CONTENT:
            raise _invalid(f"'content' is longer than {MAX_CONTENT} characters.")
        return {"type": kind, "path": str(p), "content": content}
    app = raw.get("app")
    if app not in OPEN_WITH:
        raise _invalid("'app' must be one of: " + ", ".join(OPEN_WITH) + ".")
    folder = _path(raw.get("path"), "path")
    act = {"type": "open_path", "app": app, "path": str(folder)}
    if raw.get("file"):
        f = _path(raw.get("file"), "file")
        if folder not in f.parents:
            raise _invalid("'file' must be inside 'path'.")
        act["file"] = str(f)
    return act


def describe(action: dict) -> str:
    k = action["type"]
    if k == "wait_user":
        return "wait for you: " + action["message"]
    if k == "run_cmd":
        return "run in cmd: " + action["command"]
    if k == "edit_file":
        return f"add a line to {Path(action['path']).name} ({action['mode']}{' ' + action['anchor'] if action['anchor'] else ''})"
    if k == "make_dir":
        return f"create the folder {action['path']}"
    if k == "write_file":
        return f"write {Path(action['path']).name} ({len(action['content'])} characters)"
    where = {"code": "VS Code", "notepad": "Notepad"}.get(action["app"], "File Explorer")
    return f"open {Path(action['path']).name} in {where}" + (f" with {Path(action['file']).name}" if action.get("file") else "")


def _find_code() -> list[str]:
    if sys.platform == "win32":
        for env in ("LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"):
            base = os.environ.get(env)
            if not base:
                continue
            exe = Path(base) / ("Programs" if env == "LOCALAPPDATA" else "") / "Microsoft VS Code" / "Code.exe"
            if exe.is_file():
                return [str(exe)]  # started directly: no shell involved
        if shutil.which("code"):
            return ["cmd", "/c", "code"]  # code.cmd needs cmd.exe; the paths were already checked for metacharacters
    elif shutil.which("code"):
        return ["code"]
    raise RequestError(ACTION_FAILED, "VS Code was not found on this computer (the 'code' command is missing).")


def run(action: dict) -> tuple[str, dict]:
    """Executes one validated file action and VERIFIES the result before reporting success."""
    k = action["type"]
    if k == "wait_user":
        return "continued", {}
    if k == "run_cmd":
        return _run_cmd(action)
    p = Path(action["path"])
    try:
        proj = p if k in ("make_dir", "open_path") else p.parent
        if proj != known_folder("desktop") and proj != root():
            LAST_PROJECT[0] = proj
        if k == "edit_file":
            return _edit_file(action, p)
        if k == "make_dir":
            existed = p.is_dir()
            p.mkdir(parents=True, exist_ok=True)
            if not p.is_dir():
                raise RequestError(ACTION_FAILED, f"The folder {p} was not created.")
            return f"folder {'already existed' if existed else 'created'}: {p}", {"path": str(p), "existed": existed}
        if k == "write_file":
            if not p.parent.is_dir():
                raise RequestError(ACTION_FAILED, f"The folder {p.parent} does not exist.")
            if p.exists() and p.stat().st_size > 0:
                raise RequestError(ACTION_FAILED, f"{p.name} already exists and is not empty, so it was not overwritten.")
            data = action["content"].encode("utf-8")
            p.write_bytes(data)
            if not p.is_file() or p.stat().st_size != len(data):
                raise RequestError(ACTION_FAILED, f"{p.name} was written but could not be verified.")
            return f"wrote {p} ({len(data)} bytes, verified)", {"path": str(p), "bytes": len(data)}
        if not p.is_dir():
            raise RequestError(ACTION_FAILED, f"The folder {p} does not exist.")
        if action["app"] == "notepad":
            if not action.get("file"):
                raise RequestError(ACTION_FAILED, "Notepad needs a file to open.")
            cmd = ["notepad.exe", action["file"]] if sys.platform == "win32" else ["xdg-open", action["file"]]
            flags = 0
        elif action["app"] == "explorer":
            cmd = ["explorer.exe", str(p)] if sys.platform == "win32" else ["xdg-open", str(p)]
            flags = 0
        else:
            cmd = _find_code() + ["--new-window", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", str(p)] + ([action["file"]] if action.get("file") else [])  # flags: no Welcome tab, no release notes, no Trust prompt -> the file opens focused and ready
            flags = 0x08000000 if cmd[0] == "cmd" else 0
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags) if flags else subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # noqa: S603
        try:
            rc = proc.wait(timeout=1.0)
            if rc not in (0, None) and action["app"] not in ("explorer", "notepad"):  # explorer.exe returns 1 on success
                raise RequestError(ACTION_FAILED, f"{action['app']} exited with code {rc}.")
        except subprocess.TimeoutExpired:
            pass
        return "launch requested", {"path": str(p), "app": action["app"]}
    except OSError as err:
        raise RequestError(ACTION_FAILED, f"{type(err).__name__}: {err}") from None


def _edit_file(action: dict, p: Path) -> tuple[str, dict]:
    """Adds text to a file that ALREADY exists (never creates a new one). A copy of the old file is kept in ~/.fidex_backups."""
    if not p.is_file():
        raise RequestError(ACTION_FAILED, f"{p} does not exist, so nothing was edited. Check the file name.")
    old = p.read_text(encoding="utf-8", errors="replace")
    bak = root() / ".fidex_backups"
    bak.mkdir(exist_ok=True)
    shutil.copy2(p, bak / (p.name + "." + str(int(p.stat().st_mtime))))
    lines = old.split("\n")
    new_lines = action["text"].split("\n")
    mode, anchor = action["mode"], action["anchor"].lower()
    if mode == "append":
        if old.endswith("\n"):
            lines.pop()
        lines += new_lines + [""]
    else:
        idx = next((i for i, ln in enumerate(lines) if anchor in ln.lower()), None)
        if idx is None:
            raise RequestError(ACTION_FAILED, f"The text '{action['anchor']}' was not found in {p.name}, so nothing was changed.")
        ind = lambda t: re.match(r"\s*", t).group(0)  # noqa: E731
        indent = ind(lines[idx])
        if mode == "after" and idx + 1 < len(lines) and lines[idx + 1].strip() and len(ind(lines[idx + 1])) > len(indent):
            indent = ind(lines[idx + 1])  # inside the block, like its neighbours
        elif mode == "before" and idx > 0 and lines[idx - 1].strip():
            indent = ind(lines[idx - 1]) if len(ind(lines[idx - 1])) > len(indent) else indent
        block = [indent + ln.lstrip() if ln.strip() else ln for ln in new_lines]
        at = idx + 1 if mode == "after" else idx
        lines[at:at] = block
    p.write_text("\n".join(lines), encoding="utf-8")
    if action["text"].strip().split("\n")[0].strip() not in p.read_text(encoding="utf-8", errors="replace"):
        raise RequestError(ACTION_FAILED, f"The change to {p.name} could not be verified.")
    LAST_PROJECT[0] = p.parent
    return f"added the line to {p.name} ({mode}), verified. The original is saved in .fidex_backups", {"path": str(p)}


def _run_cmd(action: dict) -> tuple[str, dict]:
    """Runs a command in cmd, tries the alternatives when it fails, shows the working one in a visible cmd window, returns the REAL output."""
    cmds = [action["command"]] + list(action.get("alts") or [])
    cwd = action.get("cwd") or None
    errors = []
    for c in cmds:
        try:
            if sys.platform == "win32":
                r = subprocess.run(["cmd", "/c", c], capture_output=True, text=True, timeout=25, cwd=cwd, stdin=subprocess.DEVNULL, creationflags=0x08000000)  # noqa: S603
            else:
                r = subprocess.run(["sh", "-c", c], capture_output=True, text=True, timeout=25, cwd=cwd, stdin=subprocess.DEVNULL)  # noqa: S603
        except subprocess.TimeoutExpired:
            errors.append(f"'{c}' took too long")
            continue
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        if r.returncode == 0 and out and "microsoft store" not in out.lower():
            if sys.platform == "win32":
                subprocess.Popen(["cmd", "/k", c], cwd=cwd, creationflags=0x10, stdin=subprocess.DEVNULL)  # noqa: S603  # visible cmd window with the same command
            return f"ran '{c}' in cmd. Result: {out[:300]}", {"command": c, "output": out[:2000]}
        errors.append(f"'{c}' -> {out[:120] or 'exit code ' + str(r.returncode)}")
    raise RequestError(ACTION_FAILED, "Every way failed: " + "; ".join(errors))
