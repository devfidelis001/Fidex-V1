"use strict";
// Runs every tests/node/*.test.js with Node's built-in test runner (no extra packages needed).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = path.join(__dirname, "node");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => path.join(dir, f));
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(run.status === null ? 1 : run.status);
