"use strict";
// REAL Electron smoke test: starts the real application (real main.js, real preload, real
// renderer, real Python) in a hidden window and checks the whole Step 4 chain and (Step 5) local SQLite storage.
//
//   npm run test:e2e
//
// It uses a temporary user-data folder, so it can run while FIDEX AI itself is open.
// Exit code 0 = everything passed.

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "fidex-e2e-")));
process.env.FIDEX_BACKEND_TEST = "1"; // lets the test crash Python on purpose
process.env.FIDEX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-e2e-logs-"));
require("../../src/main/main.js"); // the real application

const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

async function run() {
  const watchdog = setTimeout(() => {
    console.log("FAIL  test timed out after 60 s");
    app.exit(1);
  }, 60000);

  check("window created", await waitFor(() => BrowserWindow.getAllWindows().length > 0));
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const prefs = win.webContents.getLastWebPreferences();
  check("contextIsolation on, nodeIntegration off", prefs.contextIsolation === true && prefs.nodeIntegration === false);
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));

  check("page cannot see Node (no require/process)", (await js("typeof require + '|' + typeof process")) === "undefined|undefined");
  check("preload exposed window.fidex.backendRequest", (await js("typeof window.fidex.backendRequest")) === "function");

  check("Electron started the Python backend", await waitFor(async () => (await js("window.fidex.getBackendStatus()")).state === "ready"));
  const status = await js("window.fidex.getBackendStatus()");
  check("Python process is running", status.pid > 0 && alive(status.pid), `pid ${status.pid}, Python ${status.python}`);

  const hello = await js(`window.fidex.backendRequest("hello", { message: "Hello from FIDEX AI" })`);
  check("JavaScript sent 'Hello from FIDEX AI' and Python answered correctly", hello.ok && hello.data.reply === "Python backend received: Hello from FIDEX AI", JSON.stringify(hello.data && hello.data.reply));
  check("reply does not claim an AI brain", hello.data && hello.data.brain_connected === false);

  const bad1 = await js(`window.fidex.backendRequest(42, null)`);
  const bad2 = await js(`window.fidex.backendRequest("no.such.thing", {})`);
  const bad3 = await js(`window.fidex.backendRequest("hello", { message: 5 })`);
  check("invalid requests are refused safely", !bad1.ok && !bad2.ok && !bad3.ok && bad2.error.code === "UNKNOWN_TYPE", `${bad1.error.code}, ${bad2.error.code}, ${bad3.error.code}`);

  // Step 5: the database lives in Electron's user-data folder and is reached only through the bridge.
  check("database file created in the user-data folder", fs.existsSync(path.join(app.getPath("userData"), "db", "fidex.sqlite")));
  const conv = await js(`window.fidex.backendRequest("conversation.create", { title: "E2E conversation" })`);
  const msg = await js(`window.fidex.backendRequest("message.create", { conversation_id: ${JSON.stringify(conv.data && conv.data.id)}, role: "user", content: "saved by the e2e test" })`);
  check("conversation and message saved through window.fidex.backendRequest", conv.ok === true && msg.ok === true && msg.data.seq === 1);
  check("page has no direct database access", (await js("Object.keys(window.fidex).filter(k => /sql|database|storage/i.test(k)).length")) === 0);

  const onStartup = await js("1"); // the renderer's own startup check ran without breaking the page
  check("renderer still alive", onStartup === 1 && !win.webContents.isCrashed());

  // Python dies: the desktop application must not.
  process.kill(status.pid, "SIGKILL");
  check("status becomes 'crashed' after Python is killed", await waitFor(async () => (await js("window.fidex.getBackendStatus()")).state === "crashed"));
  check("window and application still running", !win.isDestroyed() && !win.webContents.isCrashed());
  const again = await js(`window.fidex.backendRequest("hello", { message: "Hello from FIDEX AI" })`);
  check("next request restarts Python and works", again.ok === true);
  const kept = await js(`window.fidex.backendRequest("message.list", { conversation_id: ${JSON.stringify(conv.data && conv.data.id)} })`);
  check("saved data is still there after Python was killed and restarted", kept.ok === true && kept.data.total === 1 && kept.data.items[0].content === "saved by the e2e test");

  // Shutdown: Python must be gone after the app quits.
  const finalPid = (await js("window.fidex.getBackendStatus()")).pid;
  clearTimeout(watchdog);
  app.once("quit", () => {
    const gone = !alive(finalPid);
    check("Python is stopped when the application quits", gone);
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    app.exit(failed ? 1 : 0);
  });
  app.quit();
}

app.whenReady().then(() =>
  run().catch((err) => {
    console.log("FAIL  test crashed: " + (err && err.stack ? err.stack : err));
    app.exit(1);
  })
);
