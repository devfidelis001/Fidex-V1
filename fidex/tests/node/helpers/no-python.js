"use strict";
// Makes "Python is not available on this computer" REAL for a test, without touching production
// code or the developer's own backend/.venv.
//
// Why this exists: the locator (src/main/python-locator.js) looks for Python in this order:
//   1. FIDEX_PYTHON   2. backend/.venv   3. python / py -3 (found through PATH)
// An empty PATH and a bad FIDEX_PYTHON only remove 1 and 3. backend/.venv is addressed by an
// absolute path, so it keeps working with PATH empty. On a machine that has run scripts\setup.ps1
// (every real FIDEX AI checkout) Python therefore never became "unavailable", the backend reached
// "ready", and the old test waiting for "failed" timed out.
//
// So the harness does three things together:
//   - createVenvFreeProject(): runs the REAL main process from a throw-away copy of src/ and
//     backend/app that contains no .venv (the real folder is never renamed, moved or modified);
//   - blockPython(): empty PATH + a FIDEX_PYTHON that does not exist;
//   - assertPythonUnreachable(): before the test starts, tries to start every candidate the
//     locator offers and insists that each one fails with ENOENT. If any Python could still be
//     started the test stops with a message about the HARNESS, instead of failing mysteriously
//     (or, worse, passing for the wrong reason).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pythonCandidates } = require("../../../src/main/python-locator");

const ROOT = path.join(__dirname, "..", "..", "..");
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** A copy of the project's code with NO backend/.venv. Returns { root, backendDir, cleanup }. */
function createVenvFreeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-nopy-project-"));
  const skipCaches = (src) => path.basename(src) !== "__pycache__";
  fs.cpSync(path.join(ROOT, "src"), path.join(root, "src"), { recursive: true });
  fs.cpSync(path.join(ROOT, "backend", "app"), path.join(root, "backend", "app"), { recursive: true, filter: skipCaches });
  const backendDir = path.join(root, "backend");
  if (fs.existsSync(path.join(backendDir, ".venv"))) throw new Error("harness bug: the copy must not contain .venv");
  return { root, backendDir, cleanup: () => rmDir(root) };
}

/**
 * Empty PATH (a real, empty folder) and an invalid FIDEX_PYTHON, for this process.
 * Call restore() as soon as the scenario is over.
 */
function blockPython() {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-empty-path-"));
  const saved = { PATH: process.env.PATH, FIDEX_PYTHON: process.env.FIDEX_PYTHON };
  process.env.PATH = emptyDir;
  process.env.FIDEX_PYTHON = path.join(emptyDir, "no-such-python-binary");
  let restored = false;
  return {
    emptyDir,
    restore() {
      if (restored) return;
      restored = true;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmDir(emptyDir);
    },
  };
}

/** Throws unless EVERY candidate fails to start because the program does not exist (ENOENT). */
function assertPythonUnreachable(candidates) {
  if (!candidates.length) throw new Error("harness bug: the locator returned no candidates to check");
  for (const c of candidates) {
    const r = spawnSync(c.command, [...(c.args || []), "--version"], { windowsHide: true, timeout: 5000, encoding: "utf8" });
    if (!(r.error && r.error.code === "ENOENT")) {
      const how = r.error ? `error ${r.error.code}` : `exit status ${r.status}, output "${String(r.stdout || r.stderr).trim()}"`;
      throw new Error(`The test harness failed to block Python: candidate "${c.label || c.command}" could still be started (${how}).`);
    }
  }
}

/** Full path of a Python that works on this machine (found the same way the app finds it). */
function findWorkingPython() {
  const probe = "import sys; print(sys.executable)";
  for (const c of pythonCandidates({ backendDir: path.join(ROOT, "backend") })) {
    const r = spawnSync(c.command, [...(c.args || []), "-c", probe], { windowsHide: true, timeout: 10000, encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/).pop();
  }
  throw new Error("No working Python found on this machine (run scripts\\setup.ps1).");
}

module.exports = { createVenvFreeProject, blockPython, assertPythonUnreachable, findWorkingPython };
