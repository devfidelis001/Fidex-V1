"use strict";
// Tests of the test harness itself (helpers/no-python.js). If these pass, a green
// "Python unavailable" test really did run with Python unreachable.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createVenvFreeProject, blockPython, assertPythonUnreachable } = require("./helpers/no-python");

const REAL_ROOT = path.join(__dirname, "..", "..");

test("the guard refuses to continue if some candidate CAN still be started", () => {
  // `node` is certainly startable, so it stands in for "a Python the harness failed to block"
  assert.throws(
    () => assertPythonUnreachable([{ command: "definitely-not-a-real-python-xyz", args: [], label: "missing" }, { command: process.execPath, args: [], label: "reachable" }]),
    /failed to block Python: candidate "reachable" could still be started/
  );
});

test("the guard accepts candidates that cannot be started (ENOENT)", () => {
  assertPythonUnreachable([
    { command: "definitely-not-a-real-python-xyz", args: [], label: "a" },
    { command: path.join(REAL_ROOT, "no", "such", "python"), args: ["-3"], label: "b" },
  ]);
});

test("the guard refuses an empty candidate list (nothing would have been checked)", () => {
  assert.throws(() => assertPythonUnreachable([]), /no candidates/);
});

test("the venv-free project copy has the real code but no .venv, and the real project is untouched", (t) => {
  const venvBefore = fs.existsSync(path.join(REAL_ROOT, "backend", ".venv"));
  const project = createVenvFreeProject();
  t.after(() => project.cleanup());
  assert.ok(fs.existsSync(path.join(project.root, "src", "main", "main.js")));
  assert.ok(fs.existsSync(path.join(project.root, "src", "preload", "preload.js")));
  assert.ok(fs.existsSync(path.join(project.backendDir, "app", "main.py")));
  assert.ok(fs.existsSync(path.join(project.backendDir, "app", "database.py")));
  assert.equal(fs.existsSync(path.join(project.backendDir, ".venv")), false);
  assert.equal(fs.existsSync(path.join(project.backendDir, "tests")), false, "only what the app needs is copied");
  assert.equal(fs.existsSync(path.join(REAL_ROOT, "backend", ".venv")), venvBefore, "the real backend/.venv was neither moved nor deleted");
  project.cleanup();
  assert.equal(fs.existsSync(project.root), false, "cleanup removes the copy");
});

test("blockPython empties PATH, breaks FIDEX_PYTHON, and restore() puts both back exactly", () => {
  const savedPath = process.env.PATH;
  const savedPy = process.env.FIDEX_PYTHON;
  for (const initialPy of [undefined, "/some/python"]) {
    if (initialPy === undefined) delete process.env.FIDEX_PYTHON;
    else process.env.FIDEX_PYTHON = initialPy;
    const block = blockPython();
    try {
      assert.deepEqual(fs.readdirSync(process.env.PATH), [], "PATH is a real, empty folder");
      assert.equal(fs.existsSync(process.env.FIDEX_PYTHON), false);
    } finally {
      block.restore();
    }
    assert.equal(process.env.PATH, savedPath);
    assert.equal(process.env.FIDEX_PYTHON, initialPy);
    block.restore(); // calling it twice is harmless
  }
  if (savedPy === undefined) delete process.env.FIDEX_PYTHON;
  else process.env.FIDEX_PYTHON = savedPy;
  assert.equal(process.env.PATH, savedPath);
});
