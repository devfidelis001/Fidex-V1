"use strict";
// src/main/python-locator.js: which Pythons are offered, in what order, and what the bridge does
// when the first ones do not work. The ordering tests build their own temporary backend folders
// and use the `platform` option, so they behave the same on Windows, macOS and Linux.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pythonCandidates } = require("../../src/main/python-locator");
const { makeBridge, BACKEND_DIR } = require("./helpers/backend");
const { findWorkingPython } = require("./helpers/no-python");

const MISSING = path.join(os.tmpdir(), "fidex-no-such-python-binary");

/** A backend folder; pass a platform ("win32"/"linux") to give it that platform's .venv interpreter. */
function backendDirWithVenv(t, platform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-locator-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  if (platform) {
    const sub = platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
    fs.mkdirSync(path.join(dir, ".venv", sub[0]), { recursive: true });
    fs.writeFileSync(path.join(dir, ".venv", ...sub), "");
  }
  return dir;
}

// Fake "Pythons": Node scripts that mimic broken interpreters. The bridge appends `-u -m app.main`.
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-loc-fakes-"));
process.on("exit", () => fs.rmSync(FAKE_DIR, { recursive: true, force: true }));
let fakeCount = 0;
function fakePython(source, label) {
  const file = path.join(FAKE_DIR, `fake${++fakeCount}.js`);
  fs.writeFileSync(file, source);
  return { command: process.execPath, args: [file], label };
}

// ---------------------------------------------------------------- order and content
test("locator order on Linux/macOS: FIDEX_PYTHON, then .venv, then python3, then python", (t) => {
  const dir = backendDirWithVenv(t, "linux");
  const list = pythonCandidates({ backendDir: dir, env: { FIDEX_PYTHON: "/custom/python" }, platform: "linux" });
  assert.deepEqual(list.map((c) => c.label), ["FIDEX_PYTHON", "backend/.venv", "python3 (PATH)", "python (PATH)"]);
  assert.equal(list[0].command, "/custom/python");
  assert.equal(list[1].command, path.join(dir, ".venv", "bin", "python"));
});

test("locator order on Windows: FIDEX_PYTHON, then .venv\\Scripts\\python.exe, then python, then py -3", (t) => {
  const dir = backendDirWithVenv(t, "win32");
  const list = pythonCandidates({ backendDir: dir, env: { FIDEX_PYTHON: "C:\\Python\\python.exe" }, platform: "win32" });
  assert.deepEqual(list.map((c) => c.label), ["FIDEX_PYTHON", "backend/.venv", "python (PATH)", "py -3"]);
  assert.equal(list[1].command, path.join(dir, ".venv", "Scripts", "python.exe"));
  assert.deepEqual(list[3], { command: "py", args: ["-3"], label: "py -3" });
});

test("the virtual environment is offered only when its interpreter file exists", (t) => {
  const none = backendDirWithVenv(t, null);
  assert.deepEqual(pythonCandidates({ backendDir: none, env: {}, platform: "win32" }).map((c) => c.label), ["python (PATH)", "py -3"]);
  fs.mkdirSync(path.join(none, ".venv", "Scripts"), { recursive: true }); // folder, but no python.exe inside
  assert.deepEqual(pythonCandidates({ backendDir: none, env: {}, platform: "win32" }).map((c) => c.label), ["python (PATH)", "py -3"]);
});

test("a .venv made for the other platform is ignored", (t) => {
  const linuxVenv = backendDirWithVenv(t, "linux");
  assert.ok(!pythonCandidates({ backendDir: linuxVenv, env: {}, platform: "win32" }).some((c) => c.label === "backend/.venv"));
  const winVenv = backendDirWithVenv(t, "win32");
  assert.ok(!pythonCandidates({ backendDir: winVenv, env: {}, platform: "linux" }).some((c) => c.label === "backend/.venv"));
});

test("an unset or empty FIDEX_PYTHON is skipped", (t) => {
  const dir = backendDirWithVenv(t, null);
  for (const env of [{}, { FIDEX_PYTHON: "" }, { FIDEX_PYTHON: undefined }]) {
    assert.ok(!pythonCandidates({ backendDir: dir, env, platform: "linux" }).some((c) => c.label === "FIDEX_PYTHON"));
  }
});

test("every candidate has a command, an args array and a label, and calls do not share objects", (t) => {
  const dir = backendDirWithVenv(t, "linux");
  const a = pythonCandidates({ backendDir: dir, env: { FIDEX_PYTHON: "/x/python" }, platform: "win32" });
  for (const c of a) {
    assert.equal(typeof c.command, "string");
    assert.ok(c.command.length > 0);
    assert.ok(Array.isArray(c.args));
    assert.equal(typeof c.label, "string");
  }
  const b = pythonCandidates({ backendDir: dir, env: { FIDEX_PYTHON: "/x/python" }, platform: "win32" });
  a[a.length - 1].args.push("mutated");
  assert.deepEqual(b[b.length - 1].args, ["-3"]);
});

test("with no options it reads the real environment and platform", () => {
  const saved = process.env.FIDEX_PYTHON;
  process.env.FIDEX_PYTHON = MISSING;
  try {
    const list = pythonCandidates({ backendDir: BACKEND_DIR });
    assert.equal(list[0].label, "FIDEX_PYTHON");
    assert.equal(list[0].command, MISSING);
    assert.ok(list.some((c) => /\(PATH\)|py -3/.test(c.label)));
  } finally {
    if (saved === undefined) delete process.env.FIDEX_PYTHON;
    else process.env.FIDEX_PYTHON = saved;
  }
});

// ---------------------------------------------------------------- the cause of the old test failure
test("ROOT CAUSE of the old Node-test failure: an existing .venv is offered by absolute path, so an empty PATH and a bad FIDEX_PYTHON cannot make Python 'unavailable'", (t) => {
  for (const platform of ["win32", "linux"]) {
    const dir = backendDirWithVenv(t, platform);
    const list = pythonCandidates({ backendDir: dir, env: { FIDEX_PYTHON: MISSING, PATH: "" }, platform });
    const venv = list.find((c) => c.label === "backend/.venv");
    assert.ok(venv, `${platform}: the venv candidate is still there with PATH empty`);
    assert.ok(path.isAbsolute(venv.command), `${platform}: it is an absolute path, so PATH does not matter to it`);
    // whereas the PATH-based fallbacks are bare names that depend entirely on PATH
    for (const c of list.filter((x) => /\(PATH\)|py -3/.test(x.label))) {
      assert.ok(!c.command.includes(path.sep) && !c.command.includes("/"), `${platform}: ${c.label} is looked up through PATH`);
    }
  }
});

// ---------------------------------------------------------------- fallback behaviour (real processes)
test("fallback: a FIDEX_PYTHON that does not exist is skipped and the next working Python starts the backend", async (t) => {
  const candidates = pythonCandidates({ backendDir: BACKEND_DIR, env: { FIDEX_PYTHON: MISSING } });
  assert.equal(candidates[0].label, "FIDEX_PYTHON");
  const bridge = makeBridge({ candidates });
  t.after(() => bridge.stop());
  const status = await bridge.start();
  assert.equal(status.state, "ready");
  assert.notEqual(status.pythonLabel, "FIDEX_PYTHON", "a later candidate was used");
  assert.ok(bridge.logs.some((l) => l.startsWith("warn:") && l.includes("FIDEX_PYTHON") && l.includes("not found")), "the skipped candidate is logged");
  assert.equal((await bridge.request("ping")).ok, true);
});

test("fallback: a broken virtual environment (starts, then dies) is skipped too", async (t) => {
  const stale = fakePython('process.stderr.write("No Python at \'C:\\\\gone\\\\python.exe\'\\n"); process.exit(106);', "backend/.venv");
  const working = pythonCandidates({ backendDir: BACKEND_DIR, env: {} }).filter((c) => c.label !== "backend/.venv");
  const bridge = makeBridge({ candidates: [{ command: MISSING, args: [], label: "FIDEX_PYTHON" }, stale, ...working] });
  t.after(() => bridge.stop());
  const status = await bridge.start();
  assert.equal(status.state, "ready");
  assert.ok(!["FIDEX_PYTHON", "backend/.venv"].includes(status.pythonLabel));
  assert.ok(bridge.logs.some((l) => l.includes("backend/.venv") && l.includes("exit code 106")), "why the venv was skipped is logged");
});

test("fallback: the first candidate that works is the one used, and later ones are never started", async (t) => {
  const python = findWorkingPython();
  const never = fakePython('require("fs").writeFileSync(process.env.FIDEX_MARKER, "started"); setInterval(()=>{},1000);', "must-not-start");
  const marker = path.join(FAKE_DIR, "marker-" + Date.now());
  const bridge = makeBridge({
    candidates: [{ command: python, args: [], label: "FIDEX_PYTHON" }, never],
    env: { FIDEX_BACKEND_TEST: "1", FIDEX_MARKER: marker },
  });
  t.after(() => bridge.stop());
  const status = await bridge.start();
  assert.equal(status.pythonLabel, "FIDEX_PYTHON");
  assert.equal(fs.existsSync(marker), false);
});

test("when every candidate fails, the error names each one, in order, with its reason", async () => {
  const bridge = makeBridge({
    candidates: [
      { command: MISSING, args: [], label: "FIDEX_PYTHON" },
      fakePython("process.exit(3)", "backend/.venv"),
      { command: MISSING + "-2", args: ["-3"], label: "py -3" },
    ],
  });
  await assert.rejects(
    () => bridge.start(),
    (e) => {
      assert.equal(e.code, "BACKEND_UNAVAILABLE");
      const m = e.message;
      assert.match(m, /^Could not start the Python backend\. Tried: /);
      const order = ["FIDEX_PYTHON: not found", "backend/.venv: exited before it was ready (exit code 3)", "py -3: not found"].map((x) => m.indexOf(x));
      assert.ok(order.every((i) => i >= 0), m);
      assert.deepEqual([...order].sort((a, b) => a - b), order, "reported in the order they were tried");
      return true;
    }
  );
  assert.equal(bridge.state, "failed");
  assert.equal(bridge.getStatus().pid, null);
  const res = await bridge.request("hello", { message: "x" });
  assert.deepEqual([res.ok, res.error.code], [false, "BACKEND_UNAVAILABLE"]);
});
