"use strict";
// Real Node bridge <-> real Python process. No mocks of either side.

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeBridge, sleep, isAlive, waitFor } = require("./helpers/backend");
const { pythonCandidates } = require("../../src/main/python-locator");

const HELLO = "Hello from FIDEX AI";

// Fake "Python" programs (Node scripts) for the failure-mode tests. The bridge appends
// `-u -m app.main` to whatever command it starts; a script file simply ignores those arguments.
const fs = require("fs");
const os = require("os");
const path = require("path");
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-fake-"));
process.on("exit", () => fs.rmSync(FAKE_DIR, { recursive: true, force: true }));
let fakeCount = 0;
function fakeBackend(source, label) {
  const file = path.join(FAKE_DIR, `fake${++fakeCount}.js`);
  fs.writeFileSync(file, source);
  return { command: process.execPath, args: [file], label };
}

test("Electron side can start the Python backend", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  assert.equal(bridge.state, "stopped");
  const status = await bridge.start();
  assert.equal(status.state, "ready");
  assert.ok(status.pid > 0 && isAlive(status.pid), "Python process is running");
  assert.equal(status.protocol, 1);
  assert.match(status.python, /^3\.\d+/);
});

test("JavaScript sends 'Hello from FIDEX AI' and receives Python's reply", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const res = await bridge.request("hello", { message: HELLO });
  assert.equal(res.ok, true);
  assert.equal(res.type, "hello");
  assert.equal(res.data.reply, `Python backend received: ${HELLO}`);
  assert.equal(res.data.received, HELLO);
  assert.equal(res.data.brain_connected, false, "must not pretend the AI brain is connected");
  assert.ok(bridge.logs.some((l) => /request ok\s+id=\d+ type=hello/.test(l)), "success is logged");
});

test("the first request starts Python by itself (lazy start)", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  const res = await bridge.request("ping");
  assert.equal(res.ok, true);
  assert.equal(res.data.pong, true);
});

test("unicode and large messages survive the round trip", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  const text = "café ✓ 中文 🚀";
  assert.equal((await bridge.request("hello", { message: text })).data.received, text);
  const big = await bridge.request("debug.big", { size: 500000 });
  assert.equal(big.data.text.length, 500000);
});

test("invalid requests are refused safely and the backend keeps working", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const circular = {};
  circular.self = circular;
  const cases = [
    [undefined, {}, "INVALID_REQUEST"],
    [null, {}, "INVALID_REQUEST"],
    [42, {}, "INVALID_REQUEST"],
    ["", {}, "INVALID_REQUEST"],
    ["Not Valid", {}, "INVALID_REQUEST"],
    ["a".repeat(65), {}, "INVALID_REQUEST"],
    ["../etc/passwd", {}, "INVALID_REQUEST"],
    ["hello", "a string", "INVALID_REQUEST"],
    ["hello", [1, 2], "INVALID_REQUEST"],
    ["hello", circular, "INVALID_REQUEST"],
    ["hello", { message: "x".repeat(2 * 1024 * 1024) }, "REQUEST_TOO_LARGE"],
    ["no.such.handler", {}, "UNKNOWN_TYPE"],
    ["hello", {}, "INVALID_PAYLOAD"],
    ["hello", { message: 12345 }, "INVALID_PAYLOAD"],
    ["debug.raise", {}, "HANDLER_ERROR"],
  ];
  for (const [type, payload, code] of cases) {
    const res = await bridge.request(type, payload);
    assert.equal(res.ok, false, `${String(type).slice(0, 20)}`);
    assert.equal(res.error.code, code, `${String(type).slice(0, 20)} -> ${JSON.stringify(res.error)}`);
    assert.equal(typeof res.error.message, "string");
  }
  const pid = bridge.getStatus().pid;
  assert.equal((await bridge.request("hello", { message: HELLO })).ok, true);
  assert.equal(bridge.getStatus().pid, pid, "same Python process: nothing restarted");
});

test("null/undefined payload is treated as an empty object", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  assert.equal((await bridge.request("ping", null)).ok, true);
  assert.equal((await bridge.request("ping", undefined)).ok, true);
});

test("stray print() inside Python cannot corrupt communication", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  assert.equal((await bridge.request("debug.print")).ok, true);
  assert.equal((await bridge.request("ping")).ok, true);
  assert.ok(await waitFor(() => bridge.logs.some((l) => l.includes("[python] stray text"))), "goes to the log instead");
});

test("a slow request does not block other requests (non-blocking)", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const slow = bridge.request("debug.sleep", { seconds: 1 });
  const t0 = Date.now();
  const fast = await bridge.request("ping");
  assert.equal(fast.ok, true);
  assert.ok(Date.now() - t0 < 700, "ping answered while the slow request was still running");
  assert.equal(bridge.getStatus().pending, 1);
  assert.equal((await slow).ok, true);
  assert.equal(bridge.getStatus().pending, 0);
});

test("the Node event loop stays responsive while Python works", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const slow = bridge.request("debug.sleep", { seconds: 1 });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  await slow;
  clearInterval(timer);
  assert.ok(ticks > 30, `event loop kept ticking (${ticks} ticks in ~1 s)`);
});

test("many concurrent requests are all answered with the right answer", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const messages = Array.from({ length: 40 }, (_, i) => `message ${i}`);
  const results = await Promise.all(messages.map((m) => bridge.request("hello", { message: m })));
  results.forEach((r, i) => {
    assert.equal(r.ok, true);
    assert.equal(r.data.received, messages[i], "each caller gets its own answer");
  });
});

test("a request that takes too long times out, and a late answer is ignored", async (t) => {
  const bridge = makeBridge({ requestTimeoutMs: 300 });
  t.after(() => bridge.stop());
  await bridge.start();
  const res = await bridge.request("debug.sleep", { seconds: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "BACKEND_TIMEOUT");
  assert.equal(bridge.getStatus().pending, 0);
  await sleep(1000); // the late answer arrives now
  assert.ok(bridge.logs.some((l) => l.includes("no waiting request")), "late response ignored and logged");
  assert.equal((await bridge.request("ping")).ok, true, "backend still healthy");
  assert.ok(bridge.logs.some((l) => /request timed out/.test(l)), "timeout is logged");
});

test("per-request timeout option overrides the default", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  const res = await bridge.request("debug.sleep", { seconds: 1 }, { timeoutMs: 150 });
  assert.equal(res.error.code, "BACKEND_TIMEOUT");
});

test("Python crashing does not crash Electron: waiting requests get an error, status shows crashed", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const oldPid = bridge.getStatus().pid;
  const states = [];
  bridge.on("status", (s) => states.push(s.state));

  const waiting = bridge.request("debug.sleep", { seconds: 5 });
  await sleep(100);
  const crash = await bridge.request("debug.crash");
  assert.equal(crash.ok, false);
  assert.equal(crash.error.code, "BACKEND_EXITED");
  assert.equal((await waiting).error.code, "BACKEND_EXITED");
  assert.equal(bridge.state, "crashed");
  assert.equal(bridge.getStatus().lastError.code, "BACKEND_EXITED");
  assert.ok(states.includes("crashed"));
  assert.ok(!isAlive(oldPid));
  assert.ok(bridge.logs.some((l) => l.startsWith("error:") && l.includes("stopped unexpectedly")), "crash is logged");
});

test("after a crash the next request restarts Python automatically", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const oldPid = bridge.getStatus().pid;
  await bridge.request("debug.crash");
  const res = await bridge.request("hello", { message: HELLO });
  assert.equal(res.ok, true);
  assert.equal(res.data.received, HELLO);
  assert.notEqual(bridge.getStatus().pid, oldPid);
});

test("an externally killed Python process is detected and recovered", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  const pid = bridge.getStatus().pid;
  process.kill(pid, "SIGKILL");
  assert.ok(await waitFor(() => bridge.state === "crashed"));
  assert.equal((await bridge.request("ping")).ok, true);
});

test("a crash loop is stopped instead of restarting forever", async (t) => {
  const bridge = makeBridge({ maxAutoStarts: 2 });
  t.after(() => bridge.stop());
  assert.equal((await bridge.request("debug.crash")).ok, false); // start #1, then crash
  assert.equal((await bridge.request("debug.crash")).ok, false); // start #2, then crash
  const res = await bridge.request("ping"); // would be start #3
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "BACKEND_UNAVAILABLE");
  await bridge.restart(); // an explicit restart clears the guard
  assert.equal((await bridge.request("ping")).ok, true);
});

test("when no Python can be started, requests fail gracefully (no throw, no crash)", async (t) => {
  const bridge = makeBridge({ candidates: [{ command: "definitely-not-a-real-python-xyz", args: [], label: "missing" }] });
  t.after(() => bridge.stop());
  await assert.rejects(() => bridge.start(), (e) => e.code === "BACKEND_UNAVAILABLE");
  assert.equal(bridge.state, "failed");
  const res = await bridge.request("hello", { message: HELLO });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "BACKEND_UNAVAILABLE");
  assert.ok(bridge.logs.some((l) => l.startsWith("warn:") && l.includes("missing")));
});

test("no candidates at all is reported, not thrown", async () => {
  const bridge = makeBridge({ candidates: [] });
  const res = await bridge.request("ping");
  assert.equal(res.error.code, "BACKEND_UNAVAILABLE");
});

test("falls through to the next Python when the first one is broken", async (t) => {
  const good = pythonCandidates({ backendDir: require("./helpers/backend").BACKEND_DIR });
  const bridge = makeBridge({
    candidates: [{ command: "definitely-not-a-real-python-xyz", args: [], label: "missing" }, fakeBackend("process.exit(1)", "exits-at-once"), ...good],
  });
  t.after(() => bridge.stop());
  assert.equal((await bridge.request("ping")).ok, true);
  assert.equal(bridge.logs.filter((l) => l.startsWith("warn:") && l.includes("could not start")).length, 2);
});

test("a program that never says 'ready' times out cleanly", async (t) => {
  const bridge = makeBridge({
    startTimeoutMs: 400,
    candidates: [fakeBackend("setInterval(()=>{},1000)", "silent")],
  });
  t.after(() => bridge.stop());
  const t0 = Date.now();
  await assert.rejects(() => bridge.start(), (e) => e.code === "BACKEND_UNAVAILABLE" && /timed out/.test(e.message));
  assert.ok(Date.now() - t0 < 3000);
});

test("a wrong protocol version is refused", async (t) => {
  const fake = `console.log(JSON.stringify({event:"ready",data:{protocol:99,backend_version:"x",python:"3"}}));setInterval(()=>{},1000)`;
  const bridge = makeBridge({ candidates: [fakeBackend(fake, "wrong-protocol")] });
  t.after(() => bridge.stop());
  await assert.rejects(() => bridge.start(), /mismatch/);
});

test("garbage on stdout is ignored and logged, answers still arrive", async (t) => {
  const fake = `
    const rl=require("readline").createInterface({input:process.stdin});
    console.log("garbage before ready");
    console.log(JSON.stringify({event:"ready",data:{protocol:1,backend_version:"fake",python:"3.x"}}));
    console.log("{broken json");
    console.log("[1,2,3]");
    console.log(JSON.stringify({id:"nobody-asked",ok:true,data:{}}));
    rl.on("line",l=>{const m=JSON.parse(l);console.log(JSON.stringify({id:m.id,ok:true,type:m.type,data:{echo:m.payload}}));});`;
  const bridge = makeBridge({ candidates: [fakeBackend(fake, "fake")] });
  t.after(() => bridge.stop());
  const res = await bridge.request("echo", { a: 1 });
  assert.deepEqual(res, { ok: true, type: "echo", data: { echo: { a: 1 } } });
  assert.ok(bridge.logs.some((l) => l.includes("non-protocol line")));
  assert.ok(bridge.logs.some((l) => l.includes("no waiting request")));
});

test("stop() shuts Python down gracefully and the process is gone", async (t) => {
  const bridge = makeBridge();
  await bridge.start();
  const pid = bridge.getStatus().pid;
  const t0 = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - t0 < 2500, "graceful: no need to wait for the kill timer");
  assert.equal(bridge.state, "stopped");
  assert.ok(await waitFor(() => !isAlive(pid)), "Python process has exited");
  assert.ok(bridge.logs.some((l) => l.includes("shutdown requested")), "Python logged a clean goodbye");
  const res = await bridge.request("ping");
  assert.equal(res.error.code, "BACKEND_STOPPED", "no surprise restart after an intentional stop");
  await bridge.stop(); // stopping twice is harmless
});

test("start() after stop() works again", async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.stop());
  await bridge.start();
  await bridge.stop();
  await bridge.start();
  assert.equal((await bridge.request("ping")).ok, true);
});

test("stop() kills a Python that will not shut down", async () => {
  const bridge = makeBridge({ stopGraceMs: 400 });
  await bridge.start();
  const pid = bridge.getStatus().pid;
  const stuck = bridge.request("debug.sleep", { seconds: 30 }, { timeoutMs: 60000 });
  await sleep(100);
  // Python waits up to 2 s for running work; the 400 ms grace runs out first, so it is killed.
  const t0 = Date.now();
  await bridge.stop();
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(bridge.state, "stopped");
  assert.ok(await waitFor(() => !isAlive(pid)));
  assert.equal((await stuck).ok, false, "the waiting request got an answer");
  assert.ok(bridge.logs.some((l) => l.includes("killing it")));
});

test("stop() during startup cancels it", async () => {
  const bridge = makeBridge();
  const starting = bridge.start().catch((e) => e);
  await sleep(20);
  await bridge.stop();
  const result = await starting;
  assert.ok(result instanceof Error || result.state === "ready");
  assert.equal(bridge.state, "stopped");
});

test("Python shutdown never throws into the host process", async () => {
  const unhandled = [];
  const onRej = (e) => unhandled.push(e);
  const onExc = (e) => unhandled.push(e);
  process.on("unhandledRejection", onRej);
  process.on("uncaughtException", onExc);
  try {
    const bridge = makeBridge();
    await bridge.start();
    const pid = bridge.getStatus().pid;
    process.kill(pid, "SIGKILL");
    const inFlight = await bridge.request("ping"); // may race the kill; must still resolve
    assert.equal(typeof inFlight.ok, "boolean");
    await sleep(300);
    await bridge.stop();
    await bridge.request("ping");
    await sleep(200);
  } finally {
    process.off("unhandledRejection", onRej);
    process.off("uncaughtException", onExc);
  }
  assert.deepEqual(unhandled, []);
});

test("status events are emitted for every change", async (t) => {
  const bridge = makeBridge();
  const seen = [];
  bridge.on("status", (s) => seen.push(s.state));
  await bridge.start();
  await bridge.stop();
  assert.deepEqual(seen, ["starting", "ready", "stopping", "stopped"]);
});

test("python locator prefers FIDEX_PYTHON, then venv, then PATH", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-loc-"));
  const venvDir = path.join(dir, ".venv", "bin");
  fs.mkdirSync(venvDir, { recursive: true });
  fs.writeFileSync(path.join(venvDir, "python"), "");
  const list = pythonCandidates({ backendDir: dir, env: { FIDEX_PYTHON: "/custom/python" }, platform: "linux" });
  assert.deepEqual(list.map((c) => c.label), ["FIDEX_PYTHON", "backend/.venv", "python3 (PATH)", "python (PATH)"]);
  const win = pythonCandidates({ backendDir: dir, env: {}, platform: "win32" });
  assert.deepEqual(win.map((c) => c.command), ["python", "py"]);
  assert.deepEqual(win[1].args, ["-3"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
