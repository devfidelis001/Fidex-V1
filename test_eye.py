"""FIDEX Eye connection test (Windows-safe, shows real backend errors).

Run from the folder that contains `app/`:
    python test_eye.py

Checks: Ollama -> libs -> backend starts -> ping -> hello -> vision.start -> frames -> Ollama describes screen.
Backend stderr is captured to eye_backend.log and printed whenever something fails.
"""
import json, os, subprocess, sys, tempfile, threading, time, urllib.request

START = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(START, "eye_backend.log")
ok_all = True
SKIP = {"node_modules", ".git", "__pycache__", "venv", ".venv", "dist", "out", "build"}


def walk(root, depth=4):
    """Yield (folder, files) for root and sub-folders up to `depth` levels, skipping junk."""
    base = root.rstrip("\\/").count(os.sep)
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP]
        if d.count(os.sep) - base >= depth:
            dirs[:] = []
        yield d, files


def find_backend_root():
    """Folder that CONTAINS app/main.py (it may be FIDEX AI/backend, not FIDEX AI itself)."""
    for d, files in walk(START):
        if os.path.basename(d) == "app" and "main.py" in files and "vision.py" in files:
            return os.path.dirname(d)
    return None


HERE = find_backend_root() or START


def say(ok, name, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(("[ OK ] " if ok else "[FAIL] ") + name + (" -> " + str(detail) if detail else ""), flush=True)


def log_tail(n=40):
    try:
        with open(LOG, "r", encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:]).strip()
    except OSError:
        return "(no log)"


def show_backend_error(title):
    print(f"\n----- {title}: backend stderr (last lines of {LOG}) -----")
    print(log_tail() or "(stderr is empty)")
    print("-----------------------------------------------------------\n", flush=True)


# 1. Ollama
try:
    tags = json.load(urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=3))
    names = [m["name"] for m in tags.get("models", [])]
    say(True, "Ollama running", ", ".join(names) or "no models")
    say(any("qwen3.5" in n for n in names), "model qwen3.5:4b installed", "fix: ollama pull qwen3.5:4b")
except Exception as e:
    say(False, "Ollama running", f"{e}  (fix: start Ollama)")

# 2. Capture libs
try:
    import PIL; say(True, "pillow installed")
except ImportError:
    say(False, "pillow installed", f'"{sys.executable}" -m pip install pillow')
try:
    import dxcam; say(True, "dxcam installed")
except Exception as e:
    say(False, "dxcam installed (Pillow fallback will be used)", e)

# 2b. Is the Eye wired into the FIDEX folder?
print(f"\nProject folder searched: {START}")
found = find_backend_root()
say(found is not None, "backend folder found (contains app/main.py + app/vision.py)",
    found or f"NOT FOUND under {START}  -> the Eye files (app/, renderer/) were never copied into this project")
if found:
    app = os.path.join(found, "app")
    def has(path, text):
        try:
            return text in open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            return False
    for f in ("vision.py", "vision_handlers.py", "hands.py", "ai.py", "handlers.py"):
        say(os.path.isfile(os.path.join(app, f)), f"app/{f} present")
    say(has(os.path.join(app, "handlers.py"), "vision_handlers"), "handlers.py registers vision_handlers (vision.start/status exist)")
    say(has(os.path.join(app, "hands.py"), "vision.auto_start"), "hands.py starts the Eye with a task")
    # renderer + electron side: search the whole project (parent of backend too)
    top = os.path.dirname(found) if os.path.basename(found).lower() == "backend" else found
    js = {"panel": [], "bridge": [], "spawn": [], "preload": []}
    for d, files in walk(top, 5):
        for f in files:
            p = os.path.join(d, f)
            if f == "vision-panel.js": js["panel"].append(p)
            if f.endswith(".js") and "node_modules" not in p and os.path.getsize(p) < 400000:
                t = open(p, encoding="utf-8", errors="replace").read()
                if "backendRequest" in t and ("ipcRenderer" in t or "contextBridge" in t): js["preload"].append(p)
                if "app.main" in t and ("spawn" in t or "child_process" in t): js["spawn"].append(p)
    say(js["panel"], "renderer/js/vision-panel.js present", (js["panel"] or ["missing"])[0])
    say(js["preload"], "Electron preload exposes backendRequest", (js["preload"] or ["NOT FOUND (Eye UI cannot reach Python)"])[0])
    say(js["spawn"], "Electron main starts `python -m app.main`", (js["spawn"] or ["NOT FOUND (backend never launched by the app)"])[0])
    say(os.path.abspath(found) == os.path.abspath(START) or True, "backend working folder", found)

# 3. Sanity: can Python even import the backend? (shows the real traceback)
chk = subprocess.run([sys.executable, "-c", "import app.main, app.handlers; print('imports fine')"],
                     cwd=HERE, capture_output=True, text=True, encoding="utf-8", errors="replace")
say(chk.returncode == 0, "backend modules import", (chk.stdout.strip() if chk.returncode == 0 else "\n" + chk.stderr.strip()[-2500:]))

# 4. Start backend (stderr -> file, never hidden)
print(f"\nPython: {sys.version.split()[0]} at {sys.executable}\nStarting: python -u -m app.main  (cwd={HERE})", flush=True)
env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
env.setdefault("FIDEX_DATA_DIR", os.path.join(tempfile.gettempdir(), "fidex_eye_test"))
os.makedirs(env["FIDEX_DATA_DIR"], exist_ok=True)
errf = open(LOG, "wb")
p = subprocess.Popen([sys.executable, "-u", "-m", "app.main"], cwd=HERE, env=env,
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf)

msgs, cv = [], threading.Condition()


def reader():
    for raw in iter(p.stdout.readline, b""):
        try:
            m = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            m = {"event": "non-protocol-stdout", "data": raw.decode("utf-8", "replace")[:300]}
        with cv:
            msgs.append(m); cv.notify_all()
    with cv:
        cv.notify_all()


threading.Thread(target=reader, daemon=True).start()
n = 0


def wait_for(pred, timeout):
    end = time.time() + timeout
    with cv:
        while True:
            for m in msgs:
                if pred(m):
                    msgs.remove(m); return m
            left = end - time.time()
            if left <= 0 or p.poll() is not None and not any(pred(m) for m in msgs):
                return None
            cv.wait(min(left, 0.3))


def call(t, payload=None, wait=15):
    global n
    n += 1
    rid = str(n)
    if p.poll() is not None:
        return {"ok": False, "error": {"message": f"backend already exited with code {p.returncode}"}}
    try:
        p.stdin.write((json.dumps({"id": rid, "type": t, "payload": payload or {}}) + "\n").encode("utf-8"))
        p.stdin.flush()
    except OSError as e:
        return {"ok": False, "error": {"message": f"cannot write to backend (it died, exit code {p.poll()}): {e}"}}
    m = wait_for(lambda x: x.get("id") == rid, wait)
    return m or {"ok": False, "error": {"message": f"no reply in {wait}s (backend exit code: {p.poll()})"}}


def backend_alive():
    return p.poll() is None


try:
    ready = wait_for(lambda m: m.get("event") == "ready", 20)
    say(ready is not None, "backend started ('ready' event)",
        ready["data"] if ready else f"never became ready; process exit code = {p.poll()}")
    if ready is None:
        show_backend_error("STARTUP FAILED")
    else:
        r = call("ping"); say(r.get("ok"), "backend ping", r.get("error"))
        r = call("hello", {"message": "eye test"}); say(r.get("ok"), "backend hello", r.get("error"))
        r = call("vision.start"); say(r.get("ok"), "vision.start", r.get("error") or r["data"].get("state"))
        if r.get("ok"):
            s = {}
            for _ in range(60):  # up to ~90s for first model load
                time.sleep(1.5)
                s = call("vision.status").get("data", {}) or {}
                if not backend_alive() or s.get("error") or s.get("summary"):
                    break
            say(s.get("frames", 0) > 0, "screen frames captured", f'{s.get("frames")} frames via {s.get("capture")}')
            say(bool(s.get("summary")) and not s.get("error"), "Eye understands the screen", s.get("error") or s.get("summary"))
        call("vision.stop", wait=5)
        if not ok_all:
            show_backend_error("SOME CHECKS FAILED")
finally:
    try:
        p.stdin.close()
    except OSError:
        pass
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
    errf.close()

print(">>> EYE CONNECTED PERFECTLY" if ok_all else ">>> PROBLEMS FOUND - send me everything printed above (incl. the stderr block)")
