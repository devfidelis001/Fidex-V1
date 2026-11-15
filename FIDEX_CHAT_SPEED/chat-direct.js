"use strict";
// Normal Chat, straight to the local Ollama engine: window -> (this IPC) -> Ollama -> tokens back to the window.
// No Python, no extra model call, think:false. Take Over / Guide Me keep using the Python backend.
const http = require("http");

const agent = new http.Agent({ keepAlive: true });
const SYSTEM =
  "You are FIDEX AI, a personal AI agent on the user's Windows computer. " +
  "Reply in the user's language. Answer directly and briefly, in at most 2 short sentences unless the user asks for detail. " +
  "No preamble, no markdown, no closing offers. If unsure, say so.";
const PAST_INTRO =
  "The user is asking about an earlier conversation. These excerpts come from their saved chats. " +
  "Answer accurately from them only; quote or paraphrase what was actually said or decided, and do not invent details. " +
  "If they do not contain the answer, say you could not find it in the saved chats. You may use a few more sentences than usual.";
const OPTIONS = { num_ctx: 4096, num_predict: -1, temperature: 0.5, top_k: 20, top_p: 0.85 }; // no repeat_penalty: Ollama default, same as the raw run
const IMAGE_INTRO =
  "The user attached an image. A vision system already examined it once; its findings are below. You cannot see the image yourself, so rely only on the findings. " +
  "Answer the user's actual question using them; do not just describe the image. If the findings do not contain what is needed, say so plainly.";
const VISION_OPTIONS = { ...OPTIONS, num_predict: 300, temperature: 0.2 }; // same context size as chat, so the loaded model is reused (no reload)
const IMAGE_DIRECT =
  "The user attached an image and you can see it. Answer their actual question about it directly and briefly (as many sentences as the question needs). Read text and numbers exactly. Do not describe the image unless asked.";
const MAX_IMAGE_PX = 512; // images are shrunk to this before any model sees them (far fewer image tokens = much faster)
// Ollama server settings for speed. Apply once where the engine process is spawned: env: { ...process.env, ...OLLAMA_SPEED_ENV }
const OLLAMA_SPEED_ENV = { OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_KEEP_ALIVE: "60m", OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "2" };
const MAX_IMAGE_B64 = 8 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 6, MAX_HISTORY_CHARS = 1500, OLD_MSG_CHARS = 500, MAX_MSG = 6000; // every token of history is re-processed by Ollama on every message

// System prompt + recent history (newest messages kept within a small budget). Nothing else.
function buildMessages({ messages, past_chats, findings, direct }) {
  let system = SYSTEM;
  if (direct) system += "\n\n" + IMAGE_DIRECT;
  if (findings) system += "\n\n" + IMAGE_INTRO + "\nIMAGE FINDINGS:\n" + String(findings).slice(0, 2400);
  if (past_chats) system += "\n\n" + PAST_INTRO + "\nEarlier conversations:\n" + String(past_chats).slice(0, 2400);
  const kept = [];
  let used = 0;
  for (const m of messages.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const c = kept.length ? m.content.slice(0, m.content.includes("[Image findings:") ? 1100 : OLD_MSG_CHARS) : m.content; // the newest message is kept whole, older ones are capped
    if (kept.length && used + c.length > MAX_HISTORY_CHARS + 1100) break;
    kept.push({ role: m.role, content: c });
    used += c.length;
  }
  kept.reverse();
  while (kept.length && kept[0].role !== "user") kept.shift();
  return [{ role: "system", content: system }, ...kept];
}

function validate(payload) {
  if (!payload || typeof payload.id !== "string" || !Array.isArray(payload.messages) || !payload.messages.length) return null;
  const messages = [];
  for (const m of payload.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    messages.push({ role: m.role, content: m.content.slice(0, MAX_MSG) });
  }
  let image = null;
  if (payload.image) {
    const d = payload.image;
    if (!d || typeof d.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(d.data.slice(0, 4096)) || d.data.length < 100 || d.data.length > MAX_IMAGE_B64) return null;
    image = { data: d.data, hash: typeof d.hash === "string" ? d.hash.slice(0, 64) : "" };
  }
  return { image, id: payload.id, t0: Number.isFinite(payload.t0) ? payload.t0 : 0, messages, past_chats: typeof payload.past_chats === "string" ? payload.past_chats : "" };
}

const shrunk = new Map(); // image hash -> already-resized image
function shrinkImage(image) {
  try {
    if (image.hash && shrunk.has(image.hash)) return shrunk.get(image.hash);
    const { nativeImage } = require("electron"); // built into Electron: no new dependency
    const img = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
    let out = image;
    if (!img.isEmpty()) {
      const { width, height } = img.getSize(), big = Math.max(width, height);
      if (big > MAX_IMAGE_PX) {
        const k = MAX_IMAGE_PX / big;
        out = { ...image, data: img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: "good" }).toJPEG(85).toString("base64") };
      }
    }
    if (image.hash) { shrunk.set(image.hash, out); if (shrunk.size > 8) shrunk.delete(shrunk.keys().next().value); }
    return out;
  } catch (_) { return image; } // outside Electron / undecodable: send as is
}

const findingsHolders = new Map(); // image hash -> { req, cancelled } of the background findings call
let upUntil = 0; // engine known to be running until this time: skips the per-message engine check
const active = new Map(); // id -> { req, cancelled }
const activeChats = () => active.size;

const err = (code, message) => ({ ok: false, type: "chat.stream", error: { code, message } });

// Startup warm-up: a tiny real chat request with the exact body shape of a normal question (same system prompt, think:false,
// options, keep_alive). Loads the chat model and processes the system prompt before the first question. Retries.
async function warmupChat({ engine, logger }) {
  const t = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await new Promise((resolve) => {
      const body = JSON.stringify({ model: engine.CHAT_MODEL, messages: buildMessages({ messages: [{ role: "user", content: "Hi" }] }), stream: false, think: false, keep_alive: "60m", options: { ...OPTIONS, num_predict: 1, ...engine.RUNNER } });
      const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode === 200)); res.on("error", () => resolve(false)); });
      req.on("error", () => resolve(false));
      req.end(body);
    });
    if (logger) logger.info(`chat warm-up attempt ${attempt}: ${ok ? "ok" : "failed"} after ${Date.now() - t} ms`);
    if (ok) { warmVision({ engine, logger }); return true; } // vision warm-up runs in the background: never delays the chat warm-up or the UI
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Loads the vision-capable model and its image encoder with a tiny image, so the first real picture is not slow.
function warmVision({ engine, logger }) {
  let data = "";
  try {
    const { nativeImage } = require("electron");
    const px = Buffer.alloc(64 * 64 * 4, 128);
    data = nativeImage.createFromBuffer(px, { width: 64, height: 64 }).toJPEG(80).toString("base64");
  } catch (_) { /* no image support here: model-only warm-up below */ }
  const t = Date.now();
  const msg = data ? [{ role: "user", content: "ok", images: [data] }] : [];
  const body = JSON.stringify({ model: engine.MODEL || engine.CHAT_MODEL, messages: msg, stream: false, think: false, keep_alive: "60m", options: { ...VISION_OPTIONS, num_predict: 1, ...engine.RUNNER } });
  const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => logger && logger.info(`vision warm-up: ${res.statusCode} after ${Date.now() - t} ms`)); });
  req.on("error", () => {});
  req.end(body);
}

// Vision for an uploaded image: ONE call, reused loaded model, no streaming needed (the Brain streams the answer).
// Cached by image fingerprint so the same picture is never analysed twice. Never touches the Python desktop-vision system.
const visionCache = new Map();
const pendingFindings = new Map(); // image hash -> promise of its findings
function visionPrompt(question) {
  return "You are the vision system of an AI assistant. Look at this image and report FACTS only, in plain text, no markdown, at most 180 words: " +
    "what it is, all important visible text (verbatim), numbers, people/objects, colours, layout, and anything unusual. " +
    "Put the details most relevant to the user's request first. Never guess text you cannot read.\nUser's request: " + String(question || "Describe the image.").slice(0, 400);
}
function visionCall(engine, model, image, question, holder) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model, messages: [{ role: "user", content: visionPrompt(question), images: [image.data] }], stream: false, think: false, keep_alive: "60m", options: { ...VISION_OPTIONS, ...engine.RUNNER } });
    const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => {
      let b = ""; res.setEncoding("utf8");
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        let o = null; try { o = JSON.parse(b); } catch (_) { /* not json */ }
        if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode, message: String((o && o.error) || b).slice(0, 300) });
        const text = String((o && o.message && o.message.content) || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        resolve(text ? { ok: true, text } : { ok: false, status: 200, message: "empty" });
      });
      res.on("error", () => resolve({ ok: false, status: 0, message: "connection interrupted" }));
    });
    holder.req = req;
    req.setNoDelay(true);
    req.on("error", (e) => resolve({ ok: false, status: 0, message: e.code || e.message }));
    req.end(body);
  });
}
async function readImage(engine, image, question, holder, logger) {
  const cached = visionCache.get(image.hash);
  if (cached && image.hash) return { ok: true, text: cached, cached: true };
  let r = await visionCall(engine, engine.CHAT_MODEL, image, question, holder);
  if (!r.ok && !holder.cancelled && r.status !== 0 && engine.MODEL !== engine.CHAT_MODEL) { // the small chat model may not read images: fall back to the vision-capable model once
    if (logger) logger.warn(`vision: ${engine.CHAT_MODEL} failed (${r.status} ${r.message}); trying ${engine.MODEL}`);
    r = await visionCall(engine, engine.MODEL, image, question, holder);
  }
  if (r.ok && image.hash) { visionCache.set(image.hash, r.text); if (visionCache.size > 8) visionCache.delete(visionCache.keys().next().value); }
  return r;
}

function registerChatIpc({ ipcMain, isTrustedSender, engine, modelsDir, logger }) {

  ipcMain.handle("chat:cancel", (event, id) => {
    if (!isTrustedSender(event)) return null;
    const a = active.get(id);
    if (a) { a.cancelled = true; if (a.req) a.req.destroy(); }
    return { ok: true };
  });

  ipcMain.handle("chat:start", async (event, raw) => {
    if (!isTrustedSender(event)) return err("IPC_REFUSED", "Request refused.");
    const tIn = Date.now(); // timing 2: request arrived in the main process
    const p = validate(raw);
    if (!p) return err("INVALID_PAYLOAD", "Invalid chat request.");
    const entry = { req: null, cancelled: false };
    active.set(p.id, entry); // registered first, so Stop works at every moment
    const up = Date.now() < upUntil || (await engine.ensure({ modelsDir, log: logger }));
    if (up) upUntil = Date.now() + 30000;
    if (entry.cancelled) { active.delete(p.id); return { ok: true, type: "chat.stream", data: { text: "", cancelled: true } }; }
    if (!up) { active.delete(p.id); return err("AI_UNAVAILABLE", "Cannot reach the local Ollama engine."); }
    const tVision = 0;
    if (p.image) { // a new picture has priority: stop background findings of older pictures so they cannot hold the GPU, then shrink to 512px
      for (const [h, hd] of findingsHolders) { hd.cancelled = true; if (hd.req) hd.req.destroy(); pendingFindings.delete(h); }
      p.image = shrinkImage(p.image);
    }
    if (p.image && !event.sender.isDestroyed()) event.sender.send("chat:token", { id: p.id, stage: "Looking at the image…" });
    // ONE call: the loaded Qwen looks at the image and streams the answer to the user's question at once (no separate "describe" pass first).
    const msgs = buildMessages({ ...p, direct: !!p.image });
    if (p.image) msgs[msgs.length - 1].images = [p.image.data];
    const bodyFor = (model) => JSON.stringify({ model, messages: msgs, stream: true, think: false, keep_alive: "60m", options: { ...OPTIONS, ...engine.RUNNER } });
    let findings = "";
    const tReady = Date.now();
    const runStream = (body) => new Promise((resolve) => {
      let text = "", first = null, buf = "", settled = false, tSent = 0, tHdr = null, tThink = null, thinkChars = 0, ollama = null;
      const finish = (result) => { if (settled) return; settled = true; active.delete(p.id); resolve(result); };
      const done = () => {
        const timings = { // all in ms: UI->main IPC | engine check | prompt build+send | Ollama first byte | thinking (should be null) | first token | total | Ollama's own numbers
          ui_to_main_ms: p.t0 ? tIn - p.t0 : null, engine_check_ms: tReady - tIn, send_to_ollama_ms: tSent - tIn,
          vision_ms: tVision || null, ollama_headers_ms: tHdr && tSent ? tHdr - tSent : null, thinking_ms: tThink && tSent ? tThink - tSent : null, thinking_chars: thinkChars,
          first_token_ms: first, total_ms: Date.now() - tIn, ollama,
        };
        if (logger) logger.info(`chat ${p.id} ${JSON.stringify(timings)}`);
        finish({ ok: true, type: "chat.stream", data: { text: text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), cancelled: entry.cancelled || undefined, timings, findings: findings || undefined } });
      };
      const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => {
        tHdr = Date.now();
        if (res.statusCode !== 200) {
          let b = "";
          res.on("data", (d) => (b += d));
          res.on("end", () => {
            let msg = b; try { msg = JSON.parse(b).error || b; } catch (_) { /* plain text */ }
            finish({ ...err(res.statusCode === 404 ? "AI_MODEL_MISSING" : "AI_ERROR", String(msg).slice(0, 300)), retry: true });
          });
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let o; try { o = JSON.parse(line); } catch (_) { continue; }
            if (o.error) return finish(err("AI_ERROR", String(o.error).slice(0, 300)));
            if (o.message && o.message.thinking) { thinkChars += o.message.thinking.length; if (tThink === null) tThink = Date.now(); } // reasoning would show up here
            let piece = (o.message && o.message.content) || "";
            if (piece) {
              if (!text) piece = piece.replace(/^\s+/, "");
              if (piece) {
                if (first === null) first = Date.now() - tSent; // timing 4: first visible token
                text += piece;
                if (!event.sender.isDestroyed()) event.sender.send("chat:token", { id: p.id, text: piece });
              }
            }
            if (o.done) { ollama = { load_ms: Math.round((o.load_duration || 0) / 1e6), prompt_tokens: o.prompt_eval_count, prompt_eval_ms: Math.round((o.prompt_eval_duration || 0) / 1e6), eval_tokens: o.eval_count, eval_ms: Math.round((o.eval_duration || 0) / 1e6) }; done(); }
          }
        });
        res.on("end", () => (text || entry.cancelled ? done() : finish(err("AI_ERROR", "The AI returned an empty answer. Try asking again."))));
        res.on("error", () => (entry.cancelled ? done() : finish(err("AI_ERROR", "The connection to the AI engine was interrupted."))));
      });
      entry.req = req;
      req.setNoDelay(true);
      active.set(p.id, entry);
      req.on("error", (e) => (entry.cancelled ? done() : (upUntil = 0, finish(err("AI_UNAVAILABLE", `Cannot reach the local Ollama engine (${e.code || e.message}).`)))));
      tSent = Date.now(); // timing 3: request to Ollama sent
      req.end(body);
    });
    let result = await runStream(bodyFor(engine.CHAT_MODEL));
    if (p.image && !result.ok && result.retry && !entry.cancelled && engine.MODEL !== engine.CHAT_MODEL) { // the small model may not read images: one retry with the vision-capable model
      if (logger) logger.warn(`image: ${engine.CHAT_MODEL} failed (${result.error && result.error.message}); trying ${engine.MODEL}`);
      active.set(p.id, entry);
      result = await runStream(bodyFor(engine.MODEL));
    }
    if (p.image && result.ok && result.data && result.data.text && p.image.hash) { // after the answer is on screen: get compact findings for follow-up questions (never blocks the answer)
      const q = p.messages[p.messages.length - 1].content;
      const holder = { req: null, cancelled: false }, h = p.image.hash;
      findingsHolders.set(h, holder);
      pendingFindings.set(h, readImage(engine, p.image, q, holder, logger).then((v) => (v.ok ? v.text : "")).catch(() => "").finally(() => { if (findingsHolders.get(h) === holder) findingsHolders.delete(h); }));
      if (pendingFindings.size > 8) pendingFindings.delete(pendingFindings.keys().next().value);
    }
    if (result.ok && result.data) delete result.data.findings;
    return result;
  });

  ipcMain.handle("chat:findings", async (event, hash) => { // findings for a sent image, once the background read has finished (max 60 s)
    if (!isTrustedSender(event) || typeof hash !== "string") return "";
    const cached = visionCache.get(hash); if (cached) return cached;
    const pend = pendingFindings.get(hash); if (!pend) return "";
    return Promise.race([pend, new Promise((r) => setTimeout(() => r(""), 60000))]);
  });
  return { warmup: () => warmupChat({ engine, logger }) };
}

module.exports = { OLLAMA_SPEED_ENV, shrinkImage, registerChatIpc, buildMessages, warmupChat, activeChats };
