"use strict";

// Small logger: prints to the console and appends to a log file. Only lines the application
// writes itself are logged (request type, id, outcome, timing). Message contents are not logged.

const fs = require("fs");
const path = require("path");

const MAX_LOG_BYTES = 1024 * 1024; // when the file gets bigger than this it is rotated once

function consoleLogger(scope = "fidex") {
  const make = (level) => (message) => {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
  };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

function createFileLogger(filePath, scope = "fidex") {
  let stream = null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      if (fs.statSync(filePath).size > MAX_LOG_BYTES) fs.renameSync(filePath, filePath + ".1");
    } catch (_) {
      /* no file yet */
    }
    stream = fs.createWriteStream(filePath, { flags: "a" });
    stream.on("error", () => {
      stream = null; // logging problems must never affect the application
    });
  } catch (_) {
    stream = null;
  }

  const make = (level) => (message) => {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
    if (stream) stream.write(line + "\n");
  };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    filePath,
    close: () => {
      if (stream) stream.end();
      stream = null;
    },
  };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

module.exports = { consoleLogger, createFileLogger, silentLogger };
