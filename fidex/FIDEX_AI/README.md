# FIDEX AI

Personal AI agent, built as a **Windows desktop application** (not a website).

## Stack
- Electron + JavaScript (HTML, CSS, JS): desktop shell and interface (`src/`)
- Python: backend and future automation (`backend/`)
- Ollama: local AI engine (planned, Phase 2)
- SQLite: local storage (planned, later step; files go in `data/db/`)

## Folder layout
- `src/main/`: Electron main process (main window, Take Over window, tray, icon)
- `src/preload/`: secure bridge between main and renderer
- `src/renderer/`: interface (`index.html` main window, `overlay.html` Take Over window, stylesheets, `renderer.js`, `js/` modules)
- `assets/icons/`: FIDEX AI kite logo and the Windows app icon (`icon.ico`)
- `backend/app/`: Python backend; `backend/.venv/` is the virtual environment
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

Stylesheets: `welcome.css` (black welcome screen, fully self-contained), `styles.css` (dark theme tokens, title bar), `workspace.css`, `home.css`, `views.css`, `overlay.css` (Take Over window).

## Status
- Step 1: environment and structure (done)
- Step 2: Electron desktop shell (done)
- Step 3: JavaScript interface, dark redesign (done): black welcome screen, dark home with project input, Take Over circle + activity panel, How to Use, History, Settings, About
- Everything that looks like AI activity is a clearly labelled simulation. The AI brain, Ollama, voice recognition, task execution and the database are not built yet (later steps).

## Optional interface test
`tests/ui-smoke.py` walks through every screen in headless Chromium (needs `pip install playwright` then `playwright install chromium`). Run: `python tests/ui-smoke.py`.
