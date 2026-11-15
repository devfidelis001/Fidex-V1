"use strict";

// Works out which Python to start the backend with. Returns a list of candidates in priority
// order; the bridge tries them one after another until one answers the startup handshake.
//
//   1. FIDEX_PYTHON environment variable (explicit override)
//   2. backend/.venv  (created by scripts/setup.ps1)
//   3. python / py -3 on Windows, python3 / python elsewhere

const fs = require("fs");
const path = require("path");

function pythonCandidates({ backendDir, env = process.env, platform = process.platform }) {
  const list = [];
  if (env.FIDEX_PYTHON) list.push({ command: env.FIDEX_PYTHON, args: [], label: "FIDEX_PYTHON" });

  const venvPython =
    platform === "win32"
      ? path.join(backendDir, ".venv", "Scripts", "python.exe")
      : path.join(backendDir, ".venv", "bin", "python");
  if (fs.existsSync(venvPython)) list.push({ command: venvPython, args: [], label: "backend/.venv" });

  if (platform === "win32") {
    list.push({ command: "python", args: [], label: "python (PATH)" });
    list.push({ command: "py", args: ["-3"], label: "py -3" });
  } else {
    list.push({ command: "python3", args: [], label: "python3 (PATH)" });
    list.push({ command: "python", args: [], label: "python (PATH)" });
  }
  return list;
}

module.exports = { pythonCandidates };
