# Step 4 delivery: JavaScript <-> Python connection (v0.7.0)

Communication only. The AI brain is **not** connected: no Ollama, no Qwen, no reasoning, no browser automation, no autonomous tasks, no voice, no new database. The interface design is unchanged.

## Install (PowerShell, from the project folder)
1. Unzip, keeping the folder structure. Close any open FIDEX AI window first (only one can run).
2. First time only: `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`
   This installs Electron and creates `backend\.venv` (the Python backend needs only the standard library and Python 3.10+).
   Already set up? Run `npm install` only if `node_modules` is missing.
3. Check everything: `npm run verify` (ends with a live request to Python)
4. Run the tests: `npm test`, then `npm run test:e2e`
5. Start: `npm start`

## How it works
1. `main.js` creates a `PythonBridge` (`src/main/python-bridge.js`) and starts Python in the background: `python -u -m app.main` inside `backend/`.
2. Python prints one `{"event":"ready",...}` line. The bridge checks the protocol version; the state becomes `ready`.
3. The interface calls `window.fidex.backendRequest("hello", {message: "Hello from FIDEX AI"})`. `preload.js` forwards it over the IPC channel `backend:request` (the only door; `contextIsolation` on, `nodeIntegration` off, sandbox on).
4. `backend-ipc.js` checks the sender is one of FIDEX AI's own windows and passes the request to the bridge. The bridge validates it, gives it an id, writes one JSON line to Python's stdin and waits asynchronously (15 s timeout). Nothing blocks the interface.
5. Python (`server.py`) parses the line, runs the handler on its own thread (so slow work never blocks other requests) and writes one JSON line to stdout.
6. The bridge matches the answer to the waiting request by id and returns `{ok:true,type,data}` or `{ok:false,type,error:{code,message}}` to the interface.
7. On quit, `before-quit` asks Python to shut down (`shutdown` request), waits up to 3 s, then force-kills it. End of Python's input (Electron died) also makes Python exit by itself.

Safety details: stdout is reserved for protocol lines (a stray `print()` in Python is redirected to the log); the request size is limited (1 MB); at most 8 requests run at once in Python; invalid input never crashes either side; stale/late answers are ignored; Python errors are reported to the interface without internal details.

## Files changed or added
New:
- `backend/app/__init__.py`, `main.py` (entry point), `protocol.py`, `server.py`, `handlers.py`
- `backend/tests/helpers.py`, `test_protocol.py`, `test_handlers.py`, `test_server.py`
- `src/main/python-bridge.js`, `backend-ipc.js`, `python-locator.js`, `logger.js`
- `src/renderer/js/backend-link.js`
- `tests/run-python-tests.js`, `tests/run-node-tests.js`
- `tests/node/python-bridge.test.js`, `tests/node/main-wiring.test.js`, `tests/node/helpers/backend.js`, `tests/node/helpers/mock-electron.js`
- `tests/e2e/electron-e2e.js`, `tests/e2e/renderer-to-python.js`
- `docs/STEP4-DELIVERY.md`

Changed:
- `src/main/main.js`: starts and stops the bridge, registers the IPC channels (additions only; no existing handler touched)
- `src/preload/preload.js`: adds `backendRequest`, `getBackendStatus`, `onBackendStatus` (additions only)
- `src/renderer/js/bridge.js`: safe wrappers for the three new calls
- `src/renderer/renderer.js`: one import and one call at the end (`checkBackendConnection()`)
- `package.json`: version 0.7.0, test scripts, backend copied into packaged builds (`extraResources`)
- `scripts/verify-env.js`: checks the new files and does a live request to Python
- `tests/ui-smoke.py`: mock bridge extended with the new calls, plus one Step 4 check
- `README.md`

Not touched: every `.html` and `.css` file, all other renderer modules, `agent-sim.js`, `responder.js` (the chat still gives the labelled placeholder reply), icons, `setup.ps1`.

## Known limits
- Packaged installers (`electron-builder`) copy the `backend` folder but do not bundle a Python runtime; the target computer needs Python 3.10+. Bundling Python is a later packaging step. Packaging was not tested in this step.
- Windows-only behaviours (the `python` Store alias, `taskkill` cleanup, the `py -3` launcher) are written for Windows but could only be tested logic-wise on the Linux build machine. `npm run test:e2e` on Windows is the real confirmation.
