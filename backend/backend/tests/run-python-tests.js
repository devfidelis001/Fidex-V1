"use strict";
// Runs the Python backend tests with the same Python the application would use.
const path = require("path");
const { spawnSync } = require("child_process");
const { pythonCandidates } = require("../src/main/python-locator");

const backendDir = path.join(__dirname, "..", "backend");
for (const c of pythonCandidates({ backendDir })) {
  const probe = spawnSync(c.command, [...c.args, "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"], { windowsHide: true });
  if (probe.status !== 0) continue;
  console.log(`Python backend tests using: ${c.label || c.command}\n`);
  const run = spawnSync(c.command, [...c.args, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py", "-v"], { cwd: backendDir, stdio: "inherit", windowsHide: true });
  process.exit(run.status === null ? 1 : run.status);
}
console.error("No Python 3.10+ found. Run scripts\\setup.ps1 first (see README).");
process.exit(1);
