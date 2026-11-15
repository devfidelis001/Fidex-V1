"use strict";
// FIDEX SI bundled Ollama engine. ONE host/port everywhere: http://127.0.0.1:11435
// - starts the bundled ollama.exe (never the user's own Ollama on 11434), waits until it really answers
// - imports the model seed / FIDEX-SI-Model-*.zip into the models folder automatically (no terminal, no `ollama pull`)
// - discovers the models that are REALLY installed (/api/tags) and picks chat/vision models from them
// - watchdog: if the engine dies or stops answering it is restarted; status is real and queryable
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn, spawnSync } = require("child_process");

const HOST = process.env.FIDEX_OLLAMA_HOST || "http://127.0.0.1:11435", _u = new URL(HOST), PORT = Number(_u.port) || 11435, ADDR = `${_u.hostname}:${PORT}`;
const SPEED_ENV = { OLLAMA_KEEP_ALIVE: "-1", OLLAMA_MAX_LOADED_MODELS: "2", OLLAMA_NUM_PARALLEL: process.env.FIDEX_NUM_PARALLEL || "1", OLLAMA_FLASH_ATTENTION: process.env.FIDEX_FLASH || "1", OLLAMA_KV_CACHE_TYPE: process.env.FIDEX_KV_CACHE || "f16" };
const CHAT_PREF = [process.env.FIDEX_CHAT_MODEL || "qwen3.5:2b", "qwen3.5:4b"], BIG_PREF = [process.env.FIDEX_OLLAMA_MODEL || "qwen3.5:4b", "qwen3.5:2b"];
const VISION_MODEL = process.env.FIDEX_VISION_MODEL || "";
const RUNNER = { ...(Number(process.env.FIDEX_CHAT_NUM_THREAD) > 0 ? { num_thread: Number(process.env.FIDEX_CHAT_NUM_THREAD) } : {}), num_gpu: Number(process.env.FIDEX_CHAT_NUM_GPU) > 0 ? Number(process.env.FIDEX_CHAT_NUM_GPU) : 999 };

const st = { state: "starting", error: null, models: [], pid: 0, since: Date.now(), importing: false, restarts: 0 };
let lastOk = 0, child = null, modelsDir = null, log = null, inflight = null, watch = null, userData = null;
const listeners = new Set();
const L = (lvl, m) => { try { log && log[lvl] ? log[lvl]("[engine] " + m) : console.log("[engine] " + m); } catch (_) {} };
const set = (state, error) => { if (st.state !== state || st.error !== (error || null)) { st.state = state; st.error = error || null; for (const f of listeners) try { f(status()); } catch (_) {} } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(p, ms = 2500) {
  return new Promise((resolve) => {
    const req = http.get(HOST + p, { timeout: ms, agent: false }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(b || "{}") : null); } catch (_) { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); }); req.on("error", () => resolve(null));
  });
}
const ping = async () => !!(await getJson("/api/version"));
async function refreshModels() { const t = await getJson("/api/tags"); st.models = t && Array.isArray(t.models) ? t.models.map((m) => m.name || m.model).filter(Boolean) : []; return st.models; }
const has = (n) => st.models.some((m) => m === n || m === n + ":latest");
const pick = (pref) => pref.find(has) || st.models.find((m) => /^qwen3\.5/i.test(m)) || st.models[0] || null;

function findExe() {
  const c = [];
  if (process.env.FIDEX_OLLAMA_EXE) c.push(process.env.FIDEX_OLLAMA_EXE);
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, "ollama", "ollama.exe"));
  c.push(path.join(__dirname, "..", "..", "build-res", "ollama", "ollama.exe"), path.join(__dirname, "..", "..", "ollama", "ollama.exe"));
  if (process.env.OLLAMA_EXE) c.push(process.env.OLLAMA_EXE);
  if (process.env.LOCALAPPDATA) c.push(path.join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe"));
  c.push("C:\\Program Files\\Ollama\\ollama.exe");
  return c.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}
function resolveModelsDir(given) {
  const d = given || process.env.FIDEX_MODELS_DIR || path.join(userData || path.join(os.homedir(), ".fidex"), "models");
  fs.mkdirSync(d, { recursive: true }); return d;
}
const manifestOf = (dir, tag) => fs.existsSync(path.join(dir, "manifests", "registry.ollama.ai", "library", "qwen3.5", tag));
function packCandidates() {
  const dirs = [process.env.FIDEX_MODEL_PACK_DIR, process.resourcesPath, userData && path.join(userData, "model-pack"), path.dirname(process.execPath),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Downloads"), process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Desktop")].filter(Boolean);
  const out = []; if (process.env.FIDEX_MODEL_PACK) out.push(process.env.FIDEX_MODEL_PACK);
  for (const d of dirs) { try { for (const f of fs.readdirSync(d)) if (/^FIDEX-SI-Model-.*\.zip$/i.test(f)) out.push(path.join(d, f)); } catch (_) {} }
  return out;
}
// Copy the bundled seed and/or extract the model ZIP into the models folder (manifests/ + blobs/). Idempotent.
function importModels(dir) {
  if (manifestOf(dir, "4b") || manifestOf(dir, "2b")) return true;
  st.importing = true;
  try {
    const seed = process.resourcesPath && path.join(process.resourcesPath, "ollama-models-seed");
    if (seed && fs.existsSync(path.join(seed, "manifests"))) { L("info", "importing bundled model seed"); fs.cpSync(seed, dir, { recursive: true, force: false }); if (manifestOf(dir, "4b") || manifestOf(dir, "2b")) return true; }
    for (const z of packCandidates()) {
      L("info", "importing model pack " + z);
      const tries = [["tar", ["-xf", z, "-C", dir]]];   // Windows 10+ bsdtar reads zip64 (model pack is > 2 GB)
      if (process.platform === "win32") tries.push(["powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${z.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]]);
      else tries.push(["unzip", ["-oq", z, "-d", dir]]);
      for (const [cmd, args] of tries) {
        const r = spawnSync(cmd, args, { windowsHide: true, timeout: 30 * 60 * 1000 });
        if (r.status === 0 && (manifestOf(dir, "4b") || manifestOf(dir, "2b"))) return true;
        L("error", `model pack import via ${cmd} failed: ` + (r.stderr ? String(r.stderr).slice(0, 200) : r.error && r.error.message));
      }
    }
    return false;
  } catch (e) { L("error", "model import error: " + e.message); return false; }
  finally { st.importing = false; }
}

async function start(given) {
  userData = userData || (() => { try { return require("electron").app.getPath("userData"); } catch (_) { return null; } })();
  modelsDir = resolveModelsDir(given || modelsDir);
  if (await ping()) { await refreshModels(); return true; }   // already up (ours, or a previous run)
  const exe = findExe();
  if (!exe) { set("error", "ollama.exe was not found in the app package."); return false; }
  set("starting");
  L("info", `starting ${exe} on ${ADDR}, models ${modelsDir}`);
  try {
    child = spawn(exe, ["serve"], { windowsHide: true, stdio: "ignore", env: { ...process.env, ...SPEED_ENV, OLLAMA_HOST: ADDR, OLLAMA_MODELS: modelsDir } });
  } catch (e) { set("error", "Could not start the AI engine: " + e.message); return false; }
  st.pid = child.pid; st.since = Date.now();
  child.on("exit", (code) => { L("warn", "engine exited " + code); child = null; st.pid = 0; if (st.state !== "stopped") set("starting", "The AI engine stopped; restarting."); });
  child.on("error", (e) => set("error", "AI engine error: " + e.message));
  for (let i = 0; i < 240; i++) { if (await ping()) break; if (!child) return false; await sleep(250); }   // up to 60 s
  if (!(await ping())) { set("error", `The AI engine did not answer on ${ADDR} within 60 s.`); return false; }
  await refreshModels(); return true;
}

// Make the engine ready: running + a model installed. Single flight. Returns true when chat can be sent.
async function ensure(opts = {}) {
  if (opts.log) log = opts.log;
  if (inflight) return inflight;
  if ((st.state === "ready" || st.state === "no_model") && Date.now() - lastOk < 5000) return true;   // per-message fast path
  inflight = (async () => {
    try {
      if (!(await start(opts.modelsDir))) return false;
      if (!st.models.length) {
        set("importing");
        if (importModels(modelsDir)) await refreshModels();
      }
      if (!st.models.length) { lastOk = Date.now(); startWatch(); set("no_model", "No AI model is installed. Place FIDEX-SI-Model-qwen3.5-4b.zip next to the app (or in your Downloads folder) and restart FIDEX SI; it is imported automatically."); return true; }
      set("ready"); lastOk = Date.now(); startWatch(); return true;
    } finally { inflight = null; }
  })();
  return inflight;
}
function startWatch() {
  if (watch) return;
  watch = setInterval(async () => {
    if (inflight || st.state === "stopped") return;
    if (await ping()) { if (st.state !== "ready" && st.state !== "no_model") { await refreshModels(); set(st.models.length ? "ready" : "no_model"); } return; }
    st.restarts++; set("starting", "Connection to the AI engine lost; reconnecting.");
    ensure({ modelsDir }).catch(() => {});
  }, 5000);
  if (watch.unref) watch.unref();
}
function stop() { st.state = "stopped"; clearInterval(watch); watch = null; if (child) { try { child.kill(); } catch (_) {} child = null; } }
function status() {
  return { state: st.state, ok: st.state === "ready", host: HOST, error: st.error, models: st.models.slice(), chat: pick(CHAT_PREF), brain: pick(BIG_PREF), importing: st.importing, restarts: st.restarts, pid: st.pid };
}
function warmup(model) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: model || engine.CHAT_MODEL, messages: [], keep_alive: -1, options: { num_ctx: 4096, ...RUNNER } });
    const req = http.request(HOST + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode === 200)); });
    req.on("error", () => resolve(false)); req.end(body);
  });
}
const engine = {
  HOST, PORT, RUNNER, VISION_MODEL, warmup, OLLAMA_SPEED_ENV: SPEED_ENV, ensure, stop, status, ping, refreshModels,
  get CHAT_MODEL() { return pick(CHAT_PREF) || CHAT_PREF[1]; },
  get MODEL() { return pick(BIG_PREF) || BIG_PREF[0]; },
  onStatus(f) { listeners.add(f); return () => listeners.delete(f); },
  // for main.js: env that makes the Python backend use the same host/models
  backendEnv() { return { FIDEX_OLLAMA_HOST: HOST }; },
  async wake() { const t = Date.now(); const ok = await ensure({ modelsDir }); const s = status(); return { ok: ok && s.state === "ready", totalMs: Date.now() - t, sinceStart: Date.now() - st.since, status: s }; },
};
module.exports = engine;
