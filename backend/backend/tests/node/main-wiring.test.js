"use strict";
// The REAL main.js + preload.js + IPC module + bridge + Python, with Electron itself mocked.
// This is the "interface -> preload -> IPC -> main -> Python -> back" chain.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadApp } = require("./helpers/mock-electron");
const { sleep, isAlive, waitFor } = require("./helpers/backend");
const { createVenvFreeProject, blockPython, assertPythonUnreachable, findWorkingPython } = require("./helpers/no-python");
const { pythonCandidates } = require("../../src/main/python-locator");

const HELLO = "Hello from FIDEX AI";
process.env.FIDEX_BACKEND_TEST = "1"; // enables the crash/sleep helpers inside Python, tests only
process.env.FIDEX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-logs-"));
const quiet = () => {
  const real = console.log;
  console.log = () => {};
  return () => (console.log = real);
};

async function withApp(t, fn, loadOptions) {
  const restoreLog = quiet();
  const app = await loadApp(loadOptions);
  t.after(async () => {
    await (async () => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      app.app.emit("before-quit", event);
      await sleep(200);
    })();
    app.app.emit("will-quit", {});
    app.dispose();
    restoreLog();
  });
  await fn(app);
}

test("windows keep contextIsolation on, nodeIntegration off, sandbox on", async (t) => {
  await withApp(t, async ({ mainWindow }) => {
    const prefs = mainWindow.options.webPreferences;
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.match(prefs.preload, /preload\.js$/);
  });
});

test("preload exposes the backend API and keeps all previous functions", async (t) => {
  await withApp(t, async ({ api }) => {
    for (const name of ["backendRequest", "getBackendStatus", "onBackendStatus", "getAppInfo", "getTheme", "onThemeChanged", "minimizeWindow", "toggleMaximizeWindow", "closeWindow", "onWindowState", "openOverlay", "closeOverlay", "expandOverlay", "resizeOverlay", "sendOverlayUpdate", "onOverlayTask", "onOverlayEvent"]) {
      assert.equal(typeof api[name], "function", name);
    }
    assert.deepEqual(Object.keys(api).filter((k) => typeof api[k] !== "function"), [], "no raw objects (Node, process, ipcRenderer) leak into the page");
    assert.equal(Object.keys(api).includes("ipcRenderer"), false);
  });
});

test("starting the app starts Python in the background", async (t) => {
  await withApp(t, async ({ api }) => {
    assert.ok(await waitFor(async () => (await api.getBackendStatus()).state === "ready"), "backend reaches 'ready'");
    const status = await api.getBackendStatus();
    assert.ok(isAlive(status.pid));
  });
});

test("JS -> preload -> IPC -> main -> Python -> back: 'Hello from FIDEX AI'", async (t) => {
  await withApp(t, async ({ api }) => {
    const res = await api.backendRequest("hello", { message: HELLO });
    assert.equal(res.ok, true);
    assert.equal(res.type, "hello");
    assert.equal(res.data.reply, `Python backend received: ${HELLO}`);
    assert.equal(res.data.brain_connected, false);
  });
});

test("invalid requests through the full chain are answered safely", async (t) => {
  await withApp(t, async ({ api }) => {
    for (const [type, payload, code] of [
      [5, {}, "INVALID_REQUEST"],
      [undefined, undefined, "INVALID_REQUEST"],
      ["BAD TYPE", {}, "INVALID_REQUEST"],
      ["hello", "not an object", "INVALID_REQUEST"],
      ["nope", {}, "UNKNOWN_TYPE"],
      ["hello", { message: 1 }, "INVALID_PAYLOAD"],
    ]) {
      const res = await api.backendRequest(type, payload);
      assert.equal(res.ok, false);
      assert.equal(res.error.code, code);
    }
    assert.equal((await api.backendRequest("hello", { message: HELLO })).ok, true);
  });
});

test("a request that cannot be sent over IPC (function in payload) gives an error, not an exception", async (t) => {
  await withApp(t, async ({ api }) => {
    const res = await api.backendRequest("hello", { message: HELLO, bad: () => 1 });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "IPC_FAILED");
  });
});

test("if the IPC handler is missing the preload answers with an error instead of rejecting", async (t) => {
  await withApp(t, async ({ api, ipcHandlers }) => {
    ipcHandlers.delete("backend:request");
    const res = await api.backendRequest("ping", {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "IPC_FAILED");
  });
});

test("requests from an unknown sender are refused and never reach Python", async (t) => {
  await withApp(t, async ({ ipcHandlers, api }) => {
    await api.backendRequest("ping", {}); // make sure Python is up
    const before = (await api.getBackendStatus()).pending;
    const handler = ipcHandlers.get("backend:request");
    const res = await handler({ sender: { id: "evil" } }, "hello", { message: HELLO });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "IPC_REFUSED");
    assert.equal(await ipcHandlers.get("backend:status")({ sender: {} }), null);
    assert.equal(before, 0);
  });
});

test("Python dying does not crash the desktop app; the window is told, and the next request recovers", async (t) => {
  await withApp(t, async ({ api, mainWindow, app }) => {
    await api.backendRequest("ping", {});
    const pid = (await api.getBackendStatus()).pid;
    const seen = [];
    const off = api.onBackendStatus((s) => seen.push(s.state));
    assert.equal(typeof off, "function");

    process.kill(pid, "SIGKILL");
    assert.ok(await waitFor(() => seen.includes("crashed")), "window received the 'crashed' status");
    assert.equal(mainWindow.isDestroyed(), false, "window still open");
    assert.equal(app.quitCalls, 0, "application did not quit");

    const res = await api.backendRequest("hello", { message: HELLO });
    assert.equal(res.ok, true, "restarted automatically");
    assert.ok(seen.includes("ready"));
    off();
  });
});

// ---- Python genuinely unavailable (see helpers/no-python.js for how it is simulated) ----
// The earlier version of this test emptied PATH and broke FIDEX_PYTHON but left backend/.venv
// reachable (it is found by absolute path), so on any machine that had run setup.ps1 Python was
// still available and the backend became "ready" instead of "failed".
test("Python unavailable: the app still starts and requests report it gracefully", async (t) => {
  const project = createVenvFreeProject(); // the real main.js, from a copy without backend/.venv
  const block = blockPython(); //             empty PATH + FIDEX_PYTHON pointing at nothing
  t.after(() => {
    block.restore();
    project.cleanup();
  });

  // Precondition, checked with the real locator and real spawn: NO Python can be started now.
  const candidates = pythonCandidates({ backendDir: project.backendDir });
  assert.ok(candidates.length >= 3, "FIDEX_PYTHON and the PATH fallbacks are all being tried");
  assert.equal(candidates[0].label, "FIDEX_PYTHON");
  assert.ok(!candidates.some((c) => c.label === "backend/.venv"), "no virtual environment in the copy");
  assertPythonUnreachable(candidates);

  try {
    await withApp(
      t,
      async ({ api, mainWindow, app }) => {
        // 1. the application started and the window exists even though Python is missing
        assert.equal(mainWindow.isDestroyed(), false);

        // 2. the backend gives up cleanly: "failed", with a reason, and no process
        assert.ok(await waitFor(async () => (await api.getBackendStatus()).state === "failed"), "backend state becomes 'failed'");
        const status = await api.getBackendStatus();
        assert.equal(status.ready, false);
        assert.equal(status.pid, null);
        assert.equal(status.python, null);
        assert.equal(status.lastError.code, "BACKEND_UNAVAILABLE");
        assert.match(status.lastError.message, /Could not start the Python backend/);
        for (const c of candidates) assert.ok(status.lastError.message.includes(c.label), `the error names what was tried: ${c.label}`);

        // 3. every request is answered with a clear error. None throws, rejects or hangs.
        for (let i = 0; i < 5; i++) {
          const res = await api.backendRequest("hello", { message: HELLO });
          assert.equal(res.ok, false);
          assert.equal(res.type, "hello");
          assert.equal(res.error.code, "BACKEND_UNAVAILABLE");
          assert.equal(typeof res.error.message, "string");
        }
        const db = await api.backendRequest("conversation.list", {});
        assert.equal(db.ok, false, "database requests also report it instead of failing silently");
        assert.equal(db.error.code, "BACKEND_UNAVAILABLE");
        assert.equal((await api.backendRequest(5, {})).error.code, "INVALID_REQUEST", "bad requests are still refused before Python is even needed");

        // 4. the desktop application is unharmed
        assert.equal((await api.getBackendStatus()).state, "failed");
        assert.equal(mainWindow.isDestroyed(), false);
        assert.equal(app.quitCalls, 0);
      },
      { root: project.root }
    );
  } finally {
    block.restore(); // before the app is torn down, so shutdown runs in a normal environment
  }
});

// Control for the test above: the SAME venv-free copy, with Python reachable, must reach "ready".
// If this ever fails, the copy itself is broken, and the "failed" above would prove nothing.
test("harness control: the venv-free copy starts Python as soon as a Python is reachable", async (t) => {
  const python = findWorkingPython();
  const project = createVenvFreeProject();
  const savedPy = process.env.FIDEX_PYTHON;
  process.env.FIDEX_PYTHON = python;
  t.after(() => {
    if (savedPy === undefined) delete process.env.FIDEX_PYTHON;
    else process.env.FIDEX_PYTHON = savedPy;
  });
  let pid = null;
  try {
    await withApp(
      t,
      async ({ api }) => {
        assert.ok(await waitFor(async () => (await api.getBackendStatus()).state === "ready", 10000), "backend reaches 'ready'");
        const status = await api.getBackendStatus();
        pid = status.pid;
        assert.equal(status.pythonLabel, "FIDEX_PYTHON");
        assert.equal((await api.backendRequest("hello", { message: HELLO })).ok, true);
      },
      { root: project.root }
    );
  } finally {
    // t.after hooks run in registration order. Registered here, AFTER withApp's own hook, this one runs
    // after the app has quit and Python has stopped, so Windows no longer holds the folder open (EPERM).
    t.after(async () => {
      if (pid) assert.ok(await waitFor(() => !isAlive(pid), 5000), "Python has exited before the folder is deleted");
      project.cleanup();
    });
  }
});

test("quitting FIDEX AI shuts Python down first and leaves no process behind", async (t) => {
  const restoreLog = quiet();
  const ctx = await loadApp();
  t.after(() => {
    ctx.dispose();
    restoreLog();
  });
  await ctx.api.backendRequest("ping", {});
  const pid = (await ctx.api.getBackendStatus()).pid;
  assert.ok(isAlive(pid));

  ctx.app.quit(); // what happens when the user closes the window
  assert.equal(ctx.app.quitCalls, 1);
  assert.ok(await waitFor(() => ctx.app.quitCalls >= 2, 5000), "quit is completed after Python has stopped");
  assert.ok(!isAlive(pid), "Python process is gone");
});

test("the main-process log file records successful and failed requests", async (t) => {
  await withApp(t, async ({ api }) => {
    await api.backendRequest("hello", { message: HELLO });
    await api.backendRequest("nope", {});
    await sleep(150);
    const text = fs.readFileSync(path.join(process.env.FIDEX_LOG_DIR, "python-bridge.log"), "utf8");
    assert.match(text, /backend ready/);
    assert.match(text, /request ok\s+id=\d+ type=hello/);
    assert.match(text, /request error id=\d+ type=nope code=UNKNOWN_TYPE/);
    assert.doesNotMatch(text, /Hello from FIDEX AI/, "message contents are not written to the log");
  });
});
