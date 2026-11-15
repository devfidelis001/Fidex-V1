"use strict";

// PythonBridge: owns the Python backend process and everything that talks to it.
// It has no dependency on Electron, so it can be tested with plain Node.
//
// Protocol (see backend/app/protocol.py): one JSON object per line over stdin/stdout.
//   request  -> {"id":"1","type":"hello","payload":{...}}
//   response <- {"id":"1","ok":true,"type":"hello","data":{...}}
//            or {"id":"1","ok":false,"type":"hello","error":{"code":"...","message":"..."}}
//
// request() NEVER throws and never rejects: it always resolves with an envelope
//   {ok:true,  type, data}   or   {ok:false, type, error:{code,message}}
// so the interface can always show something sensible, whatever happens to Python.

const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const readline = require("readline");
const { silentLogger } = require("./logger");

const PROTOCOL_VERSION = 1;
const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const MAX_TYPE_LENGTH = 64;

const DEFAULTS = {
  startTimeoutMs: 10000, // how long Python may take to say "ready"
  requestTimeoutMs: 15000, // how long one request may take
  stopGraceMs: 3000, // how long Python may take to exit after "shutdown" before it is killed
  maxPayloadBytes: 1024 * 1024,
  longRequestTimeoutMs: 120000, // loading the model (ai.warmup) can take a while; AI answers (chat.reply / chat.stream) have no timer at all
  maxAutoStarts: 3, // automatic (re)starts allowed ...
  autoStartWindowMs: 60000, // ... inside this window, to avoid a crash loop
};

class BackendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BackendError";
    this.code = code;
  }
}

const errorEnvelope = (type, code, message) => ({
  ok: false,
  type: typeof type === "string" ? type : null,
  error: { code, message },
});

const isPlainObject = (v) => v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]";
const errText = (e) => (e && e.message ? e.message : String(e));

class PythonBridge extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.backendDir   folder that contains the `app` package (working directory)
   * @param {Array<{command:string,args:string[],label?:string}>} options.candidates  Pythons to try, in order
   * @param {object} [options.logger]     {debug,info,warn,error}
   * @param {object} [options.env]        extra environment variables for the Python process
   */
  constructor({ backendDir, candidates, logger = silentLogger, env = {}, ...timeouts }) {
    super();
    if (!backendDir) throw new Error("PythonBridge needs backendDir");
    this.backendDir = backendDir;
    this.candidates = candidates || [];
    this.log = logger;
    this.env = env;
    this.opts = { ...DEFAULTS, ...timeouts };

    this._state = "stopped"; // stopped | starting | ready | crashed | failed | stopping
    this._proc = null;
    this._startPromise = null;
    this._stopPromise = null;
    this._stopRequested = false;
    this._seq = 0;
    this._pending = new Map(); // id -> {resolve, timer, type, startedAt, proc}
    this._autoStarts = [];
    this._info = { python: null, pythonLabel: null, backendVersion: null, protocol: null, pid: null };
    this._lastError = null;
  }

  // ---------- status ----------
  get state() {
    return this._state;
  }

  getStatus() {
    return {
      state: this._state,
      ready: this._state === "ready",
      pid: this._proc && this._state === "ready" ? this._proc.child.pid : null,
      python: this._info.python,
      pythonLabel: this._info.pythonLabel,
      backendVersion: this._info.backendVersion,
      protocol: this._info.protocol,
      pending: this._pending.size,
      lastError: this._lastError,
    };
  }

  _setState(state, error) {
    if (error !== undefined) this._lastError = error;
    if (this._state === state) return;
    const previous = this._state;
    this._state = state;
    this.log.info(`backend state: ${previous} -> ${state}${error ? " (" + error.code + ")" : ""}`);
    this.emit("status", this.getStatus());
  }

  // ---------- start ----------
  /** Start Python (no-op if already running). Rejects with BackendError when no Python works. */
  start() {
    this._stopRequested = false;
    if (this._state === "ready") return Promise.resolve(this.getStatus());
    if (this._startPromise) return this._startPromise;
    if (this._stopPromise) {
      return this._stopPromise.then(() => this.start());
    }

    this._startPromise = this._startInner().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _startInner() {
    this._setState("starting", null);
    if (!this.candidates.length) {
      const err = new BackendError("BACKEND_UNAVAILABLE", "No Python interpreter was found to start the backend.");
      this._setState("failed", { code: err.code, message: err.message });
      throw err;
    }

    const failures = [];
    for (const candidate of this.candidates) {
      if (this._stopRequested) break;
      try {
        await this._spawnAndWaitReady(candidate);
        return this.getStatus();
      } catch (e) {
        const reason = `${candidate.label || candidate.command}: ${errText(e)}`;
        failures.push(reason);
        this.log.warn(`could not start backend with ${reason}`);
      }
    }

    const message = this._stopRequested
      ? "Backend start was cancelled."
      : "Could not start the Python backend. Tried: " + failures.join(" | ");
    const err = new BackendError("BACKEND_UNAVAILABLE", message);
    if (!this._stopRequested) this._setState("failed", { code: err.code, message });
    throw err;
  }

  _spawnAndWaitReady(candidate) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      let child;
      try {
        child = spawn(candidate.command, [...(candidate.args || []), "-u", "-m", "app.main"], {
          cwd: this.backendDir,
          env: { ...process.env, ...this.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        reject(new Error(`spawn failed: ${errText(e)}`));
        return;
      }

      const proc = { child, ready: false, closed: false, label: candidate.label || candidate.command, onClosed: [] };
      this._proc = proc;
      this.log.info(`starting Python backend (${proc.label})`);

      const timer = setTimeout(() => {
        this.log.error(`backend did not become ready within ${this.opts.startTimeoutMs} ms`);
        this._forceKill(proc);
        settle(reject, new Error("startup timed out"));
      }, this.opts.startTimeoutMs);

      proc.onReady = (data) => {
        if (!data || data.protocol !== PROTOCOL_VERSION) {
          this.log.error(`protocol mismatch: backend speaks ${data && data.protocol}, expected ${PROTOCOL_VERSION}`);
          this._forceKill(proc);
          settle(reject, new Error("protocol version mismatch"));
          return;
        }
        proc.ready = true;
        this._info = {
          python: data.python || null,
          pythonLabel: proc.label,
          backendVersion: data.backend_version || null,
          protocol: data.protocol,
          pid: child.pid,
        };
        this._setState("ready", null);
        this.log.info(`backend ready (pid ${child.pid}, Python ${data.python}, backend ${data.backend_version})`);
        settle(resolve);
      };

      proc.onStartFailure = (reason) => settle(reject, new Error(reason));

      child.on("error", (e) => {
        // e.g. ENOENT: this Python does not exist on this computer
        this.log.warn(`process error (${proc.label}): ${errText(e)}`);
        if (!proc.ready) {
          proc.closed = true;
          settle(reject, e.code === "ENOENT" ? new Error("not found") : e);
        } else {
          this._handleClosed(proc, null, null);
        }
      });

      child.stdin.on("error", (e) => {
        // EPIPE etc.: Python is gone; the 'close' handler cleans up.
        this.log.warn(`stdin error: ${errText(e)}`);
      });

      readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this._onStdoutLine(proc, line));
      readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
        if (line.trim()) this.log.info(`[python] ${line}`);
      });

      let exitTimer = null;
      child.on("exit", (code, signal) => {
        // 'close' normally follows; if a grandchild keeps the pipes open, do not wait forever.
        exitTimer = setTimeout(() => this._handleClosed(proc, code, signal), 500);
      });
      child.on("close", (code, signal) => {
        if (exitTimer) clearTimeout(exitTimer);
        this._handleClosed(proc, code, signal);
      });
    });
  }

  // ---------- incoming messages ----------
  _onStdoutLine(proc, line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      this.log.warn(`ignored a non-protocol line from Python: ${line.slice(0, 200)}`);
      return;
    }
    if (!isPlainObject(msg)) {
      this.log.warn("ignored a protocol line that is not an object");
      return;
    }

    if (typeof msg.event === "string") {
      if (msg.event === "ready") proc.onReady && !proc.ready && proc.onReady(msg.data);
      else this.emit("backend-event", { event: msg.event, data: msg.data });
      return;
    }

    const id = msg.id === null || msg.id === undefined ? null : String(msg.id);
    if (id === "shutdown") {
      this.log.info("backend acknowledged shutdown");
      return;
    }
    const entry = id !== null ? this._pending.get(id) : null;
    if (!entry) {
      const code = msg.error && msg.error.code;
      this.log.warn(`response with no waiting request (id=${id}${code ? ", " + code : ""}); ignored`);
      return;
    }
    this._pending.delete(id);
    clearTimeout(entry.timer);

    const ms = Date.now() - entry.startedAt;
    if (msg.ok === true) {
      this.log.info(`request ok    id=${id} type=${entry.type} ${ms}ms`);
      entry.resolve({ ok: true, type: entry.type, data: msg.data === undefined ? null : msg.data });
    } else {
      const e = isPlainObject(msg.error) ? msg.error : {};
      const code = typeof e.code === "string" ? e.code : "BACKEND_ERROR";
      const message = typeof e.message === "string" ? e.message : "The backend reported an error.";
      this.log.warn(`request error id=${id} type=${entry.type} code=${code} ${ms}ms`);
      entry.resolve(errorEnvelope(entry.type, code, message));
    }
  }

  // ---------- process ended ----------
  _handleClosed(proc, code, signal) {
    if (proc.closed && proc.finalised) return;
    proc.closed = true;
    proc.finalised = true;

    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    const wasReady = proc.ready;

    // Anything still waiting on this process gets an answer now.
    for (const [id, entry] of this._pending) {
      if (entry.proc !== proc) continue;
      this._pending.delete(id);
      clearTimeout(entry.timer);
      this.log.warn(`request failed id=${id} type=${entry.type}: backend exited (${reason})`);
      entry.resolve(errorEnvelope(entry.type, "BACKEND_EXITED", "The Python backend stopped before it could answer."));
    }

    if (proc.onStartFailure && !wasReady) proc.onStartFailure(`exited before it was ready (${reason})`);
    for (const fn of proc.onClosed) fn();

    if (this._proc === proc) {
      this._proc = null;
      if (this._state === "stopping" || this._stopRequested) {
        this.log.info(`backend stopped (${reason})`);
        this._setState("stopped", null);
      } else if (wasReady) {
        const error = { code: "BACKEND_EXITED", message: `The Python backend stopped unexpectedly (${reason}).` };
        this.log.error(error.message);
        this._setState("crashed", error);
      }
      // If it never became ready, _startInner decides the final state.
    }
  }

  // ---------- requests ----------
  /**
   * Send one request and wait for the answer. Always resolves.
   * @param {string} type     e.g. "hello"
   * @param {object} payload  plain JSON object
   * @param {{timeoutMs?:number}} [options]
   */
  async request(type, payload = {}, options = {}) {
    // 1. Validate before anything is sent.
    if (typeof type !== "string" || type.length === 0 || type.length > MAX_TYPE_LENGTH || !TYPE_RE.test(type)) {
      this.log.warn("rejected a request with an invalid type");
      return errorEnvelope(null, "INVALID_REQUEST", "Request type must be a lowercase name such as 'hello'.");
    }
    if (payload === undefined || payload === null) payload = {};
    if (!isPlainObject(payload)) {
      this.log.warn(`rejected request type=${type}: payload is not an object`);
      return errorEnvelope(type, "INVALID_REQUEST", "Request payload must be an object.");
    }

    const id = String(++this._seq);
    let line;
    try {
      line = JSON.stringify({ id, type, payload });
    } catch (e) {
      this.log.warn(`rejected request type=${type}: payload cannot be serialised`);
      return errorEnvelope(type, "INVALID_REQUEST", "Request payload cannot be converted to JSON.");
    }
    if (Buffer.byteLength(line, "utf8") > this.opts.maxPayloadBytes) {
      this.log.warn(`rejected request type=${type}: too large`);
      return errorEnvelope(type, "REQUEST_TOO_LARGE", "Request is too large.");
    }

    // 2. Make sure Python is running (starts it, or restarts it after a crash).
    if (this._state !== "ready") {
      if (this._stopRequested || this._state === "stopping") {
        return errorEnvelope(type, "BACKEND_STOPPED", "The Python backend has been stopped.");
      }
      if (this._state !== "starting" && !this._startAllowed()) {
        return errorEnvelope(type, "BACKEND_UNAVAILABLE", "The Python backend keeps stopping, so it was not restarted again. Restart FIDEX AI.");
      }
      try {
        await this.start();
      } catch (e) {
        return errorEnvelope(type, e.code || "BACKEND_UNAVAILABLE", errText(e));
      }
    }
    const proc = this._proc;
    if (!proc || !proc.ready || proc.closed || !proc.child.stdin.writable) {
      return errorEnvelope(type, "BACKEND_EXITED", "The Python backend is not running.");
    }

    // 3. Send and wait (without blocking anything else).
    // AI answers wait as long as the model needs: no timer. The user cancels with chat.cancel (Stop).
    const unlimited = type === "chat.reply" || type === "chat.stream";
    // Qwen-planned actions (action.decide / hands.plan) and the Qwen report after execution (action.run) can take longer than 15 s.
    const slow = type === "image.generate" || type === "transcribe_audio" || type === "ai.warmup" || type === "action.decide" || type === "action.run" || type === "hands.plan" || type === "hands.status" || type === "hands.start" || type === "hands.execute" || type === "hands.retry" || type === "hands.see_check" || type === "hands.recover_start" || type === "hands.recover_result" || type === "hands.ire_start" || type === "hands.ire_poll";
    const defaultTimeoutMs = slow ? this.opts.longRequestTimeoutMs : this.opts.requestTimeoutMs;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : unlimited ? null : defaultTimeoutMs;
    return new Promise((resolve) => {
      const entry = { resolve, type, startedAt: Date.now(), proc, timer: null };
      if (timeoutMs !== null) {
        entry.timer = setTimeout(() => {
          if (this._pending.get(id) !== entry) return;
          this._pending.delete(id);
          this.log.error(`request timed out id=${id} type=${type} after ${timeoutMs}ms`);
          resolve(errorEnvelope(type, "BACKEND_TIMEOUT", `The Python backend did not answer within ${Math.round(timeoutMs / 1000)} s.`));
        }, timeoutMs);
      }
      this._pending.set(id, entry);

      proc.child.stdin.write(line + "\n", (err) => {
        if (!err || this._pending.get(id) !== entry) return;
        this._pending.delete(id);
        clearTimeout(entry.timer);
        this.log.error(`could not write request id=${id} type=${type}: ${errText(err)}`);
        resolve(errorEnvelope(type, "BACKEND_EXITED", "The Python backend is not accepting requests."));
      });
    });
  }

  // Crash-loop guard: at most `maxAutoStarts` automatic starts per `autoStartWindowMs`.
  _startAllowed() {
    const now = Date.now();
    this._autoStarts = this._autoStarts.filter((t) => now - t < this.opts.autoStartWindowMs);
    if (this._autoStarts.length >= this.opts.maxAutoStarts) return false;
    this._autoStarts.push(now);
    return true;
  }

  /** Stop and start again (clears the crash-loop guard). */
  async restart() {
    await this.stop();
    this._autoStarts = [];
    return this.start();
  }

  // ---------- stop ----------
  /** Ask Python to shut down; kill it if it does not. Never rejects. */
  stop() {
    this._stopRequested = true;
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = this._stopInner()
      .catch((e) => this.log.error(`error while stopping backend: ${errText(e)}`))
      .finally(() => {
        this._stopPromise = null;
      });
    return this._stopPromise;
  }

  async _stopInner() {
    const proc = this._proc;
    if (!proc || proc.closed) {
      if (this._state !== "stopped") this._setState("stopped", null);
      return;
    }
    this._setState("stopping");
    this.log.info("stopping Python backend");

    const closed = new Promise((resolve) => proc.onClosed.push(resolve));
    let killed = false;
    const wait = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve("timeout"), ms);
        closed.then(() => {
          clearTimeout(t);
          resolve("closed");
        });
      });

    if (proc.ready && proc.child.stdin.writable) {
      try {
        proc.child.stdin.write(JSON.stringify({ id: "shutdown", type: "shutdown", payload: {} }) + "\n");
      } catch (_) {
        /* the process is already dying */
      }
    } else {
      killed = true;
      this._forceKill(proc);
    }

    if ((await wait(this.opts.stopGraceMs)) === "timeout" && !killed) {
      this.log.warn(`backend did not exit within ${this.opts.stopGraceMs} ms; killing it`);
      this._forceKill(proc);
      await wait(2000);
    }
    if (!proc.finalised) this._handleClosed(proc, null, "SIGKILL"); // last resort so stop() always finishes
    this._setState("stopped", null);
  }

  _forceKill(proc) {
    const { child } = proc;
    if (!child || child.pid === undefined) return;
    try {
      if (process.platform === "win32") {
        // also ends any child processes (for example when Python was started through `py`)
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 });
      }
      child.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  }

  /** Synchronous last-chance cleanup for application exit. */
  killNow() {
    const proc = this._proc;
    if (proc && !proc.closed) this._forceKill(proc);
  }
}

module.exports = { PythonBridge, BackendError, PROTOCOL_VERSION, DEFAULTS };
