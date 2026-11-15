# Step 5 delivery: local SQLite storage + Python-unavailable test fix (v0.8.0)

## Part 1: the failing Node test
- **Actual cause**: not a locator bug. The test emptied `PATH` and pointed `FIDEX_PYTHON` at a missing file, but the locator also offers `backend/.venv` by absolute path, which `PATH` does not affect. Wherever `scripts\setup.ps1` has run, Python stayed available, the backend became `ready`, and the test waiting for `failed` timed out. Reproduced in a Linux sandbox by adding a venv Python: 40/41, same failing test; without one: 41/41.
- **Fix (tests only, production untouched)**: `tests/node/helpers/no-python.js` runs the real `main.js` from a temporary copy with no `.venv`, with an empty `PATH` and a bad `FIDEX_PYTHON`, and first proves with real spawns that every locator candidate fails with `ENOENT`. A control test shows the same copy starts when Python is reachable. `no-python-harness.test.js` tests the harness itself.
- **Locator**: no change needed. New `python-locator.test.js` covers ordering (both platforms), the root cause, and fallback with real processes.

## Part 2: SQLite
See "Local storage" in `README.md`. Files: `backend/app/database.py`, `storage.py`, `storage_handlers.py`; `src/main/main.js` passes `FIDEX_DATA_DIR`; `src/renderer/js/db-client.js`.

## Extra fix found along the way
`backend/app/server.py` freed a request slot only after sending the reply, so a client with one request outstanding got `BACKEND_BUSY` from its 9th back-to-back request (reproduced with plain `ping` on the Step 4 code). The slot is now freed before the reply is sent. Regression test: `test_back_to_back_requests_from_one_client_are_never_told_busy`.

## Not changed
UI, preload API, security settings, nested `FIDEX_AI/` folder.
