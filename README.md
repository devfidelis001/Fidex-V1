# FIDEX SI

**Install:** go to the repo's **Releases** page and download `FIDEX-SI-Setup.exe` (NOT "Source code (zip)"). Run it; it creates Desktop and Start Menu shortcuts. No Node.js, npm or Python needed.
Also download `FIDEX-SI-Model-qwen3.5-4b.zip` from the same release and leave it in Downloads; FIDEX SI imports it on first run.

---

# FIDEX AI

Personal AI agent, built as a **Windows desktop application** (not a website).

## Stack
- Electron + JavaScript (HTML, CSS, JS): desktop shell and interface (`src/`)
- Python: backend and future automation (`backend/`)
- Ollama: local AI engine (planned, Phase 2)
- SQLite: local storage (Step 5, done): Python's built-in `sqlite3`; the database file lives in Electron's user-data folder

## Folder layout
- `src/main/`: Electron main process (main window, Take Over window, tray, icon) and the Python link: `python-bridge.js` (owns the Python process), `backend-ipc.js` (IPC channels), `python-locator.js` (finds Python), `logger.js`
- `src/preload/`: secure bridge between main and renderer
- `src/renderer/`: interface (`index.html` main window, `overlay.html` Take Over window, stylesheets, `renderer.js`, `js/` modules)
- `assets/icons/`: FIDEX AI kite logo and the Windows app icon (`icon.ico`)
- `backend/app/`: Python backend (`main.py` entry point, `protocol.py`, `server.py`, `handlers.py`, plus Step 5: `database.py`, `storage.py`, `storage_handlers.py`); `backend/.venv/` is the virtual environment
- `backend/tests/`: Python tests
- `data/`: local databases and logs (git-ignored)
- `config/`, `docs/`, `tests/`, `scripts/`

## Setup
From the project folder, run in PowerShell:

    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

Re-check at any time with `npm run verify`.

## Run
    npm start

## Interface modules (`src/renderer/js/`)
| File | Purpose |
|---|---|
| `router.js` | switches between pages |
| `titlebar.js`, `bridge.js` | custom window controls and the safe link to Electron |
| `commandbox.js` | reusable project / instruction input |
| `takeover.js` | Take Over page and the "recent assignments" list |
| `overlay.js` | the Take Over window: logo circle + activity panel (`overlay.html`) |
| `agent-sim.js` | SIMULATED agent (stages, questions, approvals). Replaced by the real agent later |
| `world.js` | Start Solving World Problems workspace (placeholder) |
| `history.js`, `settings.js`, `about.js` | History, Settings, About |
| `chat.js`, `responder.js`, `storage.js` | chat and conversation storage (unchanged behaviour) |
| `db-client.js` | Step 5: named wrappers (`db.conversations.create(...)` etc.) over `backendRequest`. Not loaded by the page yet; adds nothing on screen |
| `backend-link.js` | Step 4: sends the "Hello from FIDEX AI" test message to Python and logs the reply (nothing is drawn on screen) |

Stylesheets: `welcome.css` (black welcome screen, fully self-contained), `styles.css` (dark theme tokens, title bar), `workspace.css`, `home.css`, `views.css`, `overlay.css` (Take Over window).

## Status
- Step 1: environment and structure (done)
- Step 2: Electron desktop shell (done)
- Step 3: JavaScript interface, dark redesign (done): black welcome screen, dark home with project input, Take Over circle + activity panel, How to Use, History, Settings, About
- Step 4: JavaScript <-> Python connection (done, version 0.7.0): the interface can send structured requests to the Python backend and receive responses. **Communication only: no AI brain is connected.** See below and `docs/STEP4-DELIVERY.md`.
- Step 5: local SQLite storage (done, version 0.8.0): conversations, messages and tasks are stored by the Python backend and reached only through `backendRequest`. See "Local storage" below and `docs/STEP5-DELIVERY.md`. The visible interface still keeps its own history exactly as before; it is not yet switched over to the database.
- Everything that looks like AI activity is a clearly labelled simulation. The AI brain, Ollama, voice recognition and task execution are not built yet (later steps).

## How JavaScript talks to Python (Step 4)

    interface (renderer)  --window.fidex.backendRequest(type, payload)-->  preload.js
        --ipcRenderer.invoke("backend:request")-->  main process (backend-ipc.js)
        --PythonBridge.request()-->  Python process (backend/app), one JSON line on stdin
        <-- one JSON line on stdout <-- ... <-- the same way back to the interface

- Electron's main process starts Python in the background when FIDEX AI opens and stops it when FIDEX AI quits. The window never waits for Python.
- The interface never sees Node, files or processes: `contextIsolation` is on, `nodeIntegration` is off, the window is sandboxed, and only `backendRequest`, `getBackendStatus` and `onBackendStatus` were added to `window.fidex`.
- **Request**: `{"id":"1","type":"hello","payload":{"message":"Hello from FIDEX AI"}}`
- **Response**: `{"id":"1","ok":true,"type":"hello","data":{"reply":"Python backend received: Hello from FIDEX AI", ...}}` or `{"ok":false,"error":{"code":"...","message":"..."}}`
- `backendRequest` never throws and never rejects: it always gives `{ok:true,...}` or `{ok:false,error:{code,message}}`. Error codes include `INVALID_REQUEST`, `INVALID_PAYLOAD`, `UNKNOWN_TYPE`, `BACKEND_TIMEOUT` (15 s), `BACKEND_EXITED`, `BACKEND_UNAVAILABLE`, `BACKEND_STOPPED`, `IPC_FAILED`.
- If Python crashes, waiting requests get an error, FIDEX AI keeps running, and the next request restarts Python (at most 3 automatic starts per minute, to avoid a crash loop).
- Test requests: `hello`, `ping`, `backend.info`. Storage requests are listed under "Local storage". New Python features are added later by registering a handler in `backend/app/handlers.py`.
- When the app opens, the interface sends "Hello from FIDEX AI" and writes Python's reply to the developer console. Nothing new appears on screen. You can confirm it worked in `data/logs/python-bridge.log` (look for `request ok ... type=hello`).
- Logs: `data/logs/python-bridge.log` (requests, outcomes, timings, crashes, Python's own log lines; message contents are not logged).
- Python is chosen in this order: `FIDEX_PYTHON` environment variable, `backend/.venv`, then `python` / `py -3` on PATH. Python 3.10 or newer is required. The backend uses only the standard library.
- A broken or missing choice is skipped and the next one is tried; if none works the app still opens and requests answer `BACKEND_UNAVAILABLE` naming everything that was tried. Note that `backend/.venv` is found by absolute path, so it keeps working even if `PATH` is empty.

## Local storage (Step 5)

- **Where**: `<Electron userData>\db\fidex.sqlite` (on Windows normally `%APPDATA%\fidex-ai\db\fidex.sqlite`). Electron passes the folder to Python in `FIDEX_DATA_DIR`; Python creates the folder and database when the backend starts. The interface is never told the path.
- **Tables**: `conversations`, `messages` (numbered per conversation), `tasks`. Every record has a unique `id`, `created_at` and `updated_at` (ISO 8601 UTC). The schema version is kept in `PRAGMA user_version`.
- **Requests** (all through `window.fidex.backendRequest(type, payload)`): `db.status`; `conversation.create|get|list|update|delete`; `message.create|get|list|update|delete`; `task.create|get|list|update|delete`. Unknown payload fields are rejected.
- **Safety**: parameterised SQL only; every write is one transaction; NOT NULL / CHECK / UNIQUE / FOREIGN KEY rules in the schema; duplicate ids are refused (`DUPLICATE_ID`); errors never contain SQL, paths or SQLite messages. Extra error codes: `NOT_FOUND`, `DUPLICATE_ID`, `DB_UNAVAILABLE`, `DB_ERROR`.
- **Damaged file**: moved aside as `fidex.sqlite.corrupt-<time>` (never deleted) and replaced by a fresh database. A database made by a newer FIDEX AI is left untouched and reported as unavailable.

## Testing

From the project folder (PowerShell):

| Command | What it does |
|---|---|
| `npm test` | All automated tests: Python backend (136) and Node/IPC chain (67). No window opens. |
| `npm run test:python` | Python backend only (protocol, handlers, the real process over its pipes) |
| `npm run test:node` | The Electron-side bridge with a real Python process, plus `main.js` + `preload.js` under a mocked Electron |
| `npm run test:e2e` | **Real Electron** smoke test: opens the app hidden, sends "Hello from FIDEX AI", saves a conversation/message in SQLite, kills Python on purpose, checks the app survives and Python stops on quit. Needs a normal desktop session. |
| `npm run test:renderer` | Optional: the real interface in Chromium talking to real Python (needs `npm install --no-save playwright` and `npx playwright install chromium`) |
| `python tests/ui-smoke.py` | Optional: the existing interface walkthrough (see below) |
| `npm run verify` | Environment check, including a live request to Python |

What the tests prove: Electron can start Python; JavaScript can send a request; Python processes it and answers; JavaScript receives the correct answer; invalid requests (bad JSON, wrong types, unknown requests, oversized messages) are refused safely; timeouts, crashes, a missing Python and shutdown never crash the desktop application; and a slow Python request does not block anything else.

## Optional interface test
`tests/ui-smoke.py` walks through every screen in headless Chromium (needs `pip install playwright` then `playwright install chromium`). Run: `python tests/ui-smoke.py`.

## Automatic save progress (Step 6)
Tasks, steps, answers, decisions, files and instructions are saved to SQLite as they change (`backend/app/progress.py`; panel side `js/progress-saver.js`). After a restart or crash, unfinished tasks appear in recent assignments as "Interrupted: click to continue" and resume at the saved step. Restoring never executes anything; approvals not recorded as executed must be given again. See `docs/STEP6-DELIVERY.md`.
