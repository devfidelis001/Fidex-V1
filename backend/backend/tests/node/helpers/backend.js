"use strict";
const path = require("path");
const { PythonBridge } = require("../../../src/main/python-bridge");
const { pythonCandidates } = require("../../../src/main/python-locator");

const BACKEND_DIR = path.join(__dirname, "..", "..", "..", "backend");

/** A bridge wired exactly like production, plus the test-only debug handlers. */
function makeBridge(overrides = {}) {
  const logs = [];
  const logger = {};
  for (const level of ["debug", "info", "warn", "error"]) logger[level] = (m) => logs.push(`${level}: ${m}`);
  const bridge = new PythonBridge({
    backendDir: BACKEND_DIR,
    candidates: pythonCandidates({ backendDir: BACKEND_DIR }),
    logger,
    env: { FIDEX_BACKEND_TEST: "1" },
    ...overrides,
  });
  bridge.logs = logs;
  return bridge;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function waitFor(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

module.exports = { makeBridge, sleep, isAlive, waitFor, BACKEND_DIR };
