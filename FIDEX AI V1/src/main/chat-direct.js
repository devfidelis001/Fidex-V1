"use strict";
// Normal Chat, straight to the local Ollama engine: window -> (this IPC) -> Ollama -> tokens back to the window.
// No Python, no extra model call, think:false. Take Over / Guide Me keep using the Python backend.
const http = require("http");
const crypto = require("crypto");
let nativeImage = null; try { nativeImage = require("electron").nativeImage; } catch (_) { /* tests / no electron */ }
const MAX_SIDE = 640; // matches the window-side resize (image-attach.js), so main never re-decodes // photos/screens are shrunk once here: a 4000px photo costs seconds of vision time and 10x the bytes for no extra accuracy

const agent = new http.Agent({ keepAlive: true });
const SYSTEM =
  "You are FIDEX SI, a personal SI agent on the user's Windows computer. " +
  "Reply in the user's language. Answer directly and briefly, in at most 2 short sentences unless the user asks for detail. " +
  "No preamble, no markdown, no closing offers. If unsure, say so. " +
  "Talk TO the user directly, never about them or your own plan: never write \"The user ...\", \"I will ...\" or \"I should ...\". Reply naturally (\"ok\" -> \"Okay, what would you like next?\").";
// On-demand notes: added to the user turn ONLY when the message matches (one regex test, microseconds). Every other message and the system prompt stay untouched, so the brain stays at full speed.
const CURRENT_RE = /\b(today|tonight|right now|currently|current|latest|newest|recent(ly)?|this (week|month|year)|news|price of|who is the (current )?(president|ceo|prime minister|leader|champion)|what('s| is) the (date|time))\b/i;
const CORRECT_RE = /^\s*(no[,. !]|nope|wrong|that'?s (not (right|true|correct)|wrong|incorrect)|you('re| are) (wrong|not right|incorrect)|incorrect|not true|actually[, ]|correction)/i;
const PAST_INTRO =
  "The user is asking about an earlier conversation. These excerpts come from their saved chats. " +
  "Answer accurately from them only; quote or paraphrase what was actually said or decided, and do not invent details. " +
  "If they do not contain the answer, say you could not find it in the saved chats. You may use a few more sentences than usual.";
const OPTIONS = { num_ctx: 4096, num_predict: -1, temperature: 0.5, top_k: 20, top_p: 0.85 }; // no repeat_penalty: Ollama default, same as the raw run
const IMAGE_INTRO =
  "The user attached an image. A vision system already examined it once; its findings are below. You cannot see the image yourself, so rely only on the findings. " +
  "Answer the user's actual question using them; do not just describe the image. If the findings do not contain what is needed, say so plainly.";
const VISION_OPTIONS = { ...OPTIONS, num_predict: 55, temperature: 0 }; // same context size as chat, so the loaded model is reused (no reload)
const BUILDER_RE = /\b(who|whom)\b.{0,25}\b(built|made|created|develop(ed)?|programmed|designed|founded|owns?|behind|invented|coded|engineered)\b.{0,25}\b(you|fidex)\b|\b(your|fidex\W?s?)\s+(builder|creator|developer|programmer|maker|founder|owner|author|inventor)\b|\bwho\s+is\s+(behind|the\s+(builder|creator|developer|founder|ceo))\b|\bwho\s+is\s+fidelis\b/i;
// Programming requests are exempt from every "be short / be fast" rule (SpeedX included): they take the time they need and finish.
const PROG_RE = /\b(code|coding|codes|program(s|ming|mer)?|script|html|css|javascript|typescript|python|java|c\+\+|c#|php|sql|react|node\.?js|json|regex|bash|powershell|flutter|kotlin|swift|rust|django|flask|tailwind|bootstrap|debug|bug|algorithm|compile|function|website|web ?page|webpage|landing page|frontend|backend|database|github|git|npm|pip|api|css|stylesheet|snippet|source code)\b/i;
const CONT_RE = /\b(complete|continue|finish|fix|change|update|edit|modify|add|remove|replace|improve|make it|make the|rewrite|redo|again|more|bigger|smaller|color|colour|font|button|section|page|code|css|html|js|script)\b/i;
function isProg(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return false;
  if (PROG_RE.test(last.content.slice(0, 1500))) return true;
  if (CONT_RE.test(last.content.slice(0, 200))) for (let i = messages.length - 2; i >= 0 && i >= messages.length - 3; i--) if (messages[i].role === "assistant" && messages[i].content.includes("```")) return true; // only a code follow-up ("complete it", "change the color") continues the code mode; every other question is answered normally
  return false;
}
const MAX_IMAGE_B64 = 8 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 6, MAX_HISTORY_CHARS = 1500, OLD_MSG_CHARS = 500, MAX_MSG = 6000; // every token of history is re-processed by Ollama on every message

// System prompt + recent history (newest messages kept within a small budget). Nothing else.
function buildMessages({ messages, past_chats, findings, short }) {
  let system = SYSTEM;
  const prog = isProg(messages);
  const kept = [];
  let used = 0;
  for (const m of messages.slice(-MAX_HISTORY_MESSAGES).reverse()) {
    const c = kept.length ? m.content.slice(0, m.content.includes("[Image findings:") ? 1100 : prog ? 3000 : OLD_MSG_CHARS) : m.content; // the newest message is kept whole, older ones are capped
    if (kept.length && used + c.length > MAX_HISTORY_CHARS + 1100 + (prog ? 3000 : 0)) break;
    kept.push({ role: m.role, content: c });
    used += c.length;
  }
  kept.reverse();
  while (kept.length && kept[0].role !== "user") kept.shift();
  if (kept.length) { // builder fact: added to the user turn ONLY when the user asks who built FIDEX AI; every other message is untouched
    const last = kept[kept.length - 1];
    if (last.content.length < 300 && BUILDER_RE.test(last.content)) kept[kept.length - 1] = { role: "user", content: "[Fact: FIDEX SI Version 1 was built by the FIDEX Team, not by one person alone. Answer briefly from the fact.]\n" + last.content };
  }
  if (kept.length) {
    const last = kept[kept.length - 1];
    if (last.content.length < 300) {
      if (CORRECT_RE.test(last.content)) kept[kept.length - 1] = { role: "user", content: "[The user is correcting you: accept it politely, thank them, and use the correction.]\n" + last.content };
      else if (CURRENT_RE.test(last.content)) kept[kept.length - 1] = { role: "user", content: "[You have no live data. Say naturally you don't know the current one, then what you last knew, e.g. \"I don't know the current one, but last I checked it was ...\". Never invent current facts.]\n" + last.content };
    }
  }
  if (prog && kept.length) { // programming: no brevity rule, no length limit; write everything to the very end
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = { role: "user", content: "[Programming request: write the COMPLETE, working code from start to the very end. No length limit. Never stop halfway and never shorten it. Brief explanation only if needed.]\n" + last.content };
  }
  if (short && !prog && kept.length) { // SpeedX pressed: the instruction rides in the user turn, so the system prompt (and its cache) never changes
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = { role: "user", content: "[Keep the answer as short as possible: one very short sentence, a few words if that is enough. But if the request is for code, a page, a document or anything long, write it COMPLETE, to the very end, without cutting it short.]\n" + last.content };
  }
  if (past_chats && kept.length) { // memory rides in the user turn too: the system prompt never changes, so Ollama keeps its cached prefix
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = { role: "user", content: PAST_INTRO + "\nEarlier conversations:\n" + String(past_chats).slice(0, 2400) + "\n\nQuestion: " + last.content };
  }
  if (findings && kept.length) { // findings ride in the user turn: the system prompt stays byte-identical, so Ollama reuses its cached prefix instead of re-reading it
    const f = String(findings).replace(/^\s*[-*\d.)]+\s*/gm, "").replace(/\n+/g, "; ").slice(0, 500);
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = { role: "user", content: "(This is a NEW image. Ignore any earlier image or answer. What vision sees in it: " + f + ")\nUsing only that, answer in one or two short sentences: " + last.content };
    kept.splice(0, kept.length - 1); // image turn: only the current question, never the previous image's answer
  }
  return [{ role: "system", content: system }, ...kept];
}

// Shrink big images to <=1280px JPEG (text stays readable). Skips small images; on any failure keeps the original.
function shrink(b64) {
  if (!nativeImage || b64.length < 250000) return b64;
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(b64, "base64"));
    const { width, height } = img.getSize();
    if (!width || Math.max(width, height) <= MAX_SIDE) return b64;
    const k = MAX_SIDE / Math.max(width, height);
    const out = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: "good" }).toJPEG(85).toString("base64");
    return out.length < b64.length ? out : b64;
  } catch (_) { return b64; }
}

function makeImage(d) {
  if (!d || typeof d.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(d.data.slice(0, 4096)) || d.data.length < 100 || d.data.length > MAX_IMAGE_B64) return null;
  return { data: shrink(d.data), hash: crypto.createHash("sha1").update(d.data.slice(0, 200000)).update(String(d.data.length)).digest("hex") }; // fingerprint computed here, never trusted from the UI
}

function validate(payload) {
  if (!payload || typeof payload.id !== "string" || !Array.isArray(payload.messages) || !payload.messages.length) return null;
  const messages = [];
  for (const m of payload.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    messages.push({ role: m.role, content: m.content.slice(0, MAX_MSG) });
  }
  let image = null;
  if (payload.image) { image = makeImage(payload.image); if (!image) return null; }
  return { image, conv: typeof payload.conversationId === "string" ? payload.conversationId.slice(0, 64) : "", id: payload.id, t0: Number.isFinite(payload.t0) ? payload.t0 : 0, messages, past_chats: typeof payload.past_chats === "string" ? payload.past_chats : "", short: payload.short === true };
}

const active = new Map(); // id -> { req, cancelled }
const activeChats = () => active.size;

const err = (code, message) => ({ ok: false, type: "chat.stream", error: { code, message } });

// Startup warm-up: a tiny real chat request with the exact body shape of a normal question (same system prompt, think:false,
// options, keep_alive). Loads the chat model and processes the system prompt before the first question. Retries.
async function warmupChat({ engine, logger }) {
  const t = Date.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ok = await new Promise((resolve) => {
      const body = JSON.stringify({ model: engine.CHAT_MODEL, messages: buildMessages({ messages: [{ role: "user", content: "Hi" }] }), stream: false, think: false, keep_alive: -1, options: { ...OPTIONS, num_predict: 1, ...engine.RUNNER } });
      const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode === 200)); res.on("error", () => resolve(false)); });
      req.on("error", () => resolve(false));
      req.end(body);
    });
    if (logger) logger.info(`chat warm-up attempt ${attempt}: ${ok ? "ok" : "failed"} after ${Date.now() - t} ms`);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Vision for an uploaded image: ONE call, reused loaded model, no streaming needed (the Brain streams the answer).
// Cached per conversation + image fingerprint (isolated: another conversation never sees these findings). Never touches the Python desktop-vision system.
const visionCache = new Map();
const vkey = (conv, hash) => conv + ":" + hash;
function visionPrompt(question) { // minimal prompt = fast eye: only the 4 most significant things, one short line each
  return "Call out the most important thing in this image for this request FIRST, then the next 2, one short line each (max 8 words, copy visible text/numbers exactly). No intro, no extra.\nRequest: " + String(question || "Describe the image.").slice(0, 200);
}
const GENERIC_PROMPT = "Line 1: one plain sentence (max 18 words) saying what the image shows. Then up to 3 short detail lines (max 8 words each). Copy visible text exactly. No intro, no extra.";
const preCache = new Map(); // image hash -> generic findings, computed while the user types
const pfHolder = new Map(); // image hash -> running prefetch holder (partial text lets Send skip the wait)
const inflight = new Map(); // image hash -> Promise of the running prefetch
let visionModel = null; // remembered once a model is known to read images, so later images never trigger a model swap/reload
function visionCall(engine, model, image, question, holder) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model, messages: [{ role: "system", content: "Look only at the attached image. Ref " + String(image.hash).slice(0, 12) + "." }, { role: "user", content: holder.prompt || (holder.generic ? GENERIC_PROMPT : visionPrompt(question)), images: [image.data] }], stream: true, think: false, keep_alive: -1, options: { ...VISION_OPTIONS, num_predict: holder.maxTokens || (holder.generic ? 72 : 60), ...engine.RUNNER } });
    const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d));
        res.on("end", () => { let o = null; try { o = JSON.parse(b); } catch (_) { /* not json */ } resolve({ ok: false, status: res.statusCode, message: String((o && o.error) || b).slice(0, 300) }); });
        return;
      }
      let text = "", buf = "", fin = false, budget = null;
      const end = () => { clearTimeout(budget); if (fin) return; if (buf.trim()) { try { const o = JSON.parse(buf); if (o.message && o.message.content) text += o.message.content; } catch (_) { /* partial */ } buf = ""; } fin = true; const t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); resolve(t || holder.warm ? { ok: true, text: t || "-" } : { ok: false, status: 200, message: "empty" }); };
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk; let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
          let o; try { o = JSON.parse(line); } catch (_) { continue; }
          if (o.error) { if (!fin) { fin = true; resolve({ ok: false, status: 500, message: String(o.error).slice(0, 300) }); } return; }
          const piece = o.message && o.message.content;
          if (piece) {
            text += piece; if (holder.onPartial) holder.onPartial(text);
            const cut = () => { const l = text.trim().split(/\n+/).filter(Boolean); text = l.slice(0, 3).join("\n"); clearTimeout(budget); end(); req.destroy(); };
            if (!budget && !holder.noCut) budget = setTimeout(() => { if (!fin && text.trim()) cut(); }, 700); // call out while looking: 0.9 s after the first words, hand over whatever is important so far
            if (!holder.noCut && !fin && text.trim().split(/\n+/).filter(Boolean).length >= 4) return cut(); // or as soon as 3 full lines exist
          }
          if (o.done) end();
        }
      });
      res.on("end", end);
      res.on("error", () => resolve({ ok: false, status: 0, message: "connection interrupted" }));
    });
    holder.req = req;
    req.setNoDelay(true);
    req.on("error", (e) => resolve({ ok: false, status: 0, message: e.code || e.message }));
    req.end(body);
  });
}
async function runVision(engine, image, question, holder, logger) {
  visionModel = visionModel || engine.VISION_MODEL || null;
  let r = await visionCall(engine, visionModel || engine.CHAT_MODEL, image, question, holder);
  if (r.ok) visionModel = visionModel || engine.CHAT_MODEL;
  else if (!holder.cancelled && r.status !== 0 && !visionModel && engine.MODEL !== engine.CHAT_MODEL) { // the small chat model may not read images: fall back to the vision-capable model once
    if (logger) logger.warn(`vision: ${engine.CHAT_MODEL} failed (${r.status} ${r.message}); trying ${engine.MODEL}`);
    r = await visionCall(engine, engine.MODEL, image, question, holder);
    if (r.ok) visionModel = engine.MODEL;
  }
  return r;
}
const capMap = (m, n = 8) => { while (m.size > n) m.delete(m.keys().next().value); };

// Prefetch: runs when the image is attached (before Send). Generic findings, cached by image fingerprint.
function startPrefetch({ engine, image, logger, id }) {
  if (preCache.has(image.hash)) return Promise.resolve({ ok: true });
  if (inflight.has(image.hash)) return inflight.get(image.hash);
  const holder = { req: null, cancelled: false, phase: "prefetch", generic: true, noCut: true, onPartial(t) { if (!holder.firstAt) holder.firstAt = Date.now(); holder.partial = t; if (holder.fwd) holder.fwd(t); } };
  pfHolder.set(image.hash, holder);
  active.set(id, holder);
  const t = Date.now();
  const pr = runVision(engine, image, "", holder, logger).then((r) => {
    if (r.ok && !holder.cancelled) { preCache.set(image.hash, r.text); capMap(preCache); }
    if (logger) logger.info(`vision prefetch ${r.ok ? "ok" : "failed"} in ${Date.now() - t} ms`);
    return r;
  }).finally(() => { inflight.delete(image.hash); pfHolder.delete(image.hash); if (active.get(id) === holder) active.delete(id); });
  inflight.set(image.hash, pr);
  return pr;
}

async function readImage(engine, image, question, holder, logger, conv) {
  const key = vkey(conv, image.hash);
  const cached = visionCache.get(key);
  if (cached) return { ok: true, text: cached, cached: true };
  const pre = preCache.get(image.hash);
  if (pre) { visionCache.set(key, pre); return { ok: true, text: pre, cached: true, prefetched: true }; }
  const pending = inflight.get(image.hash);
  if (pending) { // the eye is already looking: join it instead of starting a second pass
    const pf = pfHolder.get(image.hash);
    if (pf && holder.onPartial) { pf.fwd = holder.onPartial; if (pf.partial) holder.onPartial(pf.partial); } // Send joined a running read: its words stream straight to the screen
    const early = holder.streamAll ? new Promise(() => {}) : new Promise((res) => { // don't wait for the full prefetch: hand over what is ready after 3 lines or 0.7 s of text
      const tick = setInterval(() => {
        const l = pf && pf.partial ? pf.partial.trim().split(/\n+/).filter(Boolean) : [];
        if (l.length >= 2) { clearInterval(tick); res({ ok: true, text: l.slice(0, 3).join("\n"), partial: true }); }
      }, 40);
      pending.finally(() => clearInterval(tick));
    });
    const r = await Promise.race([pending, early, new Promise((res) => { holder.wake = () => res({ ok: false, status: 0, message: "cancelled" }); })]);
    if (holder.cancelled) return r;
    if (r && r.ok) { if (!r.partial) { visionCache.set(key, r.text); capMap(visionCache); } return { ok: true, text: r.text, cached: true, prefetched: true }; }
  }
  const r = await runVision(engine, image, question, holder, logger);
  if (r.ok && !holder.cancelled) { visionCache.set(key, r.text); capMap(visionCache); }
  return r;
}

// Tiny valid PNG, used to load the image-reading part of the model at startup.
function blankPng(w = 112, h = 112) {
  const zlib = require("zlib");
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 200)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
// Startup: finds which model can read images and loads its image path (1 token), so the first real image is not slow.
async function warmupVision({ engine, logger }) {
  const t = Date.now();
  const r = await runVision(engine, { data: blankPng(), hash: "warm" }, "", { req: null, cancelled: false, generic: true, noCut: true, warm: true, maxTokens: 1 }, logger);
  if (logger) logger.info(`vision warm-up ${r.ok ? "ok (" + (visionModel || "?") + ")" : "failed: " + r.message} after ${Date.now() - t} ms`);
  return r.ok;
}

// Pre-fills Ollama's cache with system prompt + history while Vision runs (1 token, result ignored).
function prefill(engine, messages) {
  if (messages.length < 2) return;
  const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => res.resume());
  req.on("error", () => {});
  req.end(JSON.stringify({ model: engine.CHAT_MODEL, messages, stream: false, think: false, keep_alive: -1, options: { ...OPTIONS, num_predict: 1, ...engine.RUNNER } }));
}


// ---- Image -> code builder: the Eye reports ONE part of the picture, the Chat AI writes that part's code, then the Eye looks again
// for the next part. The code written so far is never lost: it only grows. The window shows the current step + timer at the bottom.
const BUILD_RE = /\b(build|clone|replicate|recreate|copy|copying|make|write|create|code|html|css|website|web ?page|landing page|ui|design)\b/i;
const MAX_PARTS = 8;
function streamCode(engine, messages, holder, onPiece) {
  return new Promise((resolve) => {
    let buf = "", text = "", done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => {
      if (res.statusCode !== 200) { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => fin({ ok: false, message: b.slice(0, 300) })); return; }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk; let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue;
          let o; try { o = JSON.parse(l); } catch (_) { continue; }
          if (o.error) return fin({ ok: false, message: String(o.error).slice(0, 300) });
          const piece = o.message && o.message.content;
          if (piece) { text += piece; onPiece(piece); }
          if (o.done) return fin({ ok: true, text });
        }
      });
      res.on("end", () => fin({ ok: true, text }));
      res.on("error", () => fin({ ok: holder.cancelled, text, message: "connection interrupted" }));
    });
    holder.req = req;
    req.setNoDelay(true);
    req.on("error", (e) => fin({ ok: holder.cancelled, text, message: e.code || e.message }));
    req.end(JSON.stringify({ model: engine.CHAT_MODEL, messages, stream: true, think: false, keep_alive: -1, options: { ...OPTIONS, num_ctx: 4096, num_predict: 1800, temperature: 0.15, ...engine.RUNNER } }));
  });
}
const EYE_PROMPT = "Describe this image so a developer can rebuild it exactly. Only what is visible, nothing invented. Line 1: Page: background (hex or gradient), layout (centered / columns / rows), overall look. Then one line per element, top to bottom, left to right: type | exact text | size (% of image height) | weight | text color (hex) | box color (hex) | border/radius/shadow | position and spacing. For every photo, picture, logo, avatar or icon: type (image/icon) | what it shows in 1-3 words | size | position. For repeated items (cards, rows) give the count. If a part is not drawn (navbar, footer, buttons), do not mention it. Max 200 words.";
const CODE_SYSTEM = "You are a precise front-end developer. You rebuild an image from a developer's description of it. Write the COMPLETE code yourself, from the very first line to the very last. " +
  "Default: one single self-contained HTML file inside one ```html code block: <!DOCTYPE html>, <html>, <head> (meta charset, meta viewport, title, one <style> with all CSS), <body> with the elements, and one <script> only if something visible needs behaviour. If the user asks for another language or framework, use that instead in its own fenced block. " +
  "Rules: build EXACTLY and ONLY what the description lists, with its exact text, hex colors, sizes, weights, spacing and positions. Never invent a navbar, header, footer, section, button or link that is not listed. Use semantic tags, flexbox/grid for layout, and keep every CSS rule consistent with the HTML class names you wrote. " +
  "IMAGES AND ICONS: wherever the description lists a photo, picture, logo or avatar, add a real online image, never a blank box and never an empty src: <img src=\"https://loremflickr.com/WIDTH/HEIGHT/KEYWORD\" alt=\"KEYWORD\" width=\"WIDTH\" height=\"HEIGHT\"> with WIDTH/HEIGHT the listed size and KEYWORD one or two words for what it shows (for a person's avatar use https://i.pravatar.cc/150?img=NUMBER). For a CSS background picture use the same kind of URL. Add object-fit: cover and the listed border-radius. " +
  "For every icon, add <link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css\"> in the head and use <i class=\"fa-solid fa-NAME\"></i> (or fa-brands for logos) with the closest icon name. " +
  "Output only the code block, no explanation before or after.";
async function buildFromImage({ event, engine, p, entry, logger }) {
  const send = (o) => { if (!event.sender.isDestroyed()) event.sender.send("chat:token", { id: p.id, ...o }); };
  const stage = (label) => send({ stage: "build|" + label }); // the window counts the seconds itself, restarting at 1 per step
  let shown = "";
  const emit = (t) => { if (t) { shown += t; send({ text: t }); } };
  const request = p.messages[p.messages.length - 1].content.slice(0, 300);
  // 1) ONE fast, structured look at the picture: exactly what is visible, nothing invented.
  stage("looking at the image");
  const holder = { req: null, cancelled: false, prompt: EYE_PROMPT, noCut: true, maxTokens: 280 };
  entry.stop = () => {}; entry.wake = null;
  const watch = setInterval(() => { if (entry.cancelled) { holder.cancelled = true; if (holder.req) holder.req.destroy(); } }, 150);
  let v; try { v = await runVision(engine, p.image, "", holder, logger); } finally { clearInterval(watch); }
  if (entry.cancelled) return { text: shown, cancelled: true };
  if (!v.ok) return { err: err("VISION_FAILED", "Could not read the image: " + String(v.message || "unknown error")) };
  const desc = v.text.trim();
  // 2) The brain writes EVERYTHING itself, from the first line: no skeleton, no template, nothing added around its code.
  stage("writing code");
  const msgs = [
    { role: "system", content: CODE_SYSTEM },
    { role: "user", content: "Image description:\n" + desc + "\n\nUser request (follow it): " + request },
  ];
  let head = "", started = false;
  const onPiece = (t) => { // the code streams straight to the window as it is written; only the very first characters are checked for a code fence
    if (started) return emit(t);
    head += t;
    if (head.trim().length < 3 && head.length < 12) return;
    started = true;
    emit(/^\s*```/.test(head) ? head.replace(/^\s+/, "") : "```html\n" + head.replace(/^\s+/, "")); // the model forgot the fence: only then is it added
  };
  const w = setInterval(() => { if (entry.cancelled && entry.req) entry.req.destroy(); }, 150);
  let r; try { r = await streamCode(engine, msgs, entry, onPiece); } finally { clearInterval(w); }
  if (entry.cancelled) return { text: shown, cancelled: true };
  if (!r.ok) return { err: err("AI_ERROR", String(r.message || "The AI stopped unexpectedly.")) };
  if (!started && head.trim()) emit("```html\n" + head.trim());
  if (((shown.match(/```/g) || []).length % 2) === 1) emit("\n```"); // fence left open: close it so the code block renders
  return { text: shown, findings: desc };
}

function registerChatIpc({ ipcMain, isTrustedSender, engine, modelsDir, logger }) {

  ipcMain.handle("chat:cancel", (event, id) => {
    if (!isTrustedSender(event)) return null;
    const a = active.get(id);
    if (a) { a.cancelled = true; if (a.req) a.req.destroy(); if (a.wake) a.wake(); }
    return { ok: true };
  });

  ipcMain.handle("chat:start", async (event, raw) => {
    if (!isTrustedSender(event)) return err("IPC_REFUSED", "Request refused.");
    if (raw && raw.prefetch) { // image just attached: start Vision now, while the user types
      const pid = "pf:" + String(raw.id || "").slice(0, 64);
      if (raw.cancel) { const a = active.get(pid); if (a) { a.cancelled = true; if (a.req) a.req.destroy(); } return { ok: true, type: "chat.prefetch" }; }
      const image = makeImage(raw.image);
      if (!image) return err("INVALID_PAYLOAD", "Invalid image.");
      if (!(await engine.ensure({ modelsDir, log: logger }))) return err("AI_UNAVAILABLE", "Cannot reach the local Ollama engine.");
      startPrefetch({ engine, image, logger, id: pid }); // not awaited: the window does not wait for it
      return { ok: true, type: "chat.prefetch" };
    }
    const tIn = Date.now(); // timing 2: request arrived in the main process
    const p = validate(raw);
    if (!p) return err("INVALID_PAYLOAD", "Invalid chat request.");
    const entry = { req: null, cancelled: false };
    active.set(p.id, entry); // registered first, so Stop works at every moment
    const up = await engine.ensure({ modelsDir, log: logger });
    if (entry.cancelled) { active.delete(p.id); return { ok: true, type: "chat.stream", data: { text: "", cancelled: true } }; }
    if (!up) { active.delete(p.id); return err("AI_UNAVAILABLE", "Cannot reach the local Ollama engine."); }
    // Image + "build / copy this" request: part-by-part builder (Eye -> code -> Eye -> code ... until the page is done).
    if (p.image && (isProg(p.messages) || BUILD_RE.test(p.messages[p.messages.length - 1].content)) && BUILD_RE.test(p.messages[p.messages.length - 1].content)) {
      entry.phase = "build"; entry.prog = true;
      const b = await buildFromImage({ event, engine, p, entry, logger });
      active.delete(p.id);
      prefill(engine, buildMessages({ messages: [{ role: "user", content: "Hi" }] })); // automatic refresh after the code: the chat brain is warm again for the next question
      if (b.err) return b.err;
      return { ok: true, type: "chat.stream", data: { text: b.text, cancelled: b.cancelled || undefined, findings: b.cancelled ? undefined : b.findings } };
    }
    // UI -> Chat AI -> Vision -> Chat AI -> UI -> Memory.
    // 1) Chat AI coordinates: Vision must return its findings BEFORE the answer is generated.
    const cachedNow = !!p.image && (visionCache.has(vkey(p.conv, p.image.hash)) || preCache.has(p.image.hash));
    let tVision = 0, findings = "", phase = p.image && !cachedNow ? "vision" : "chat";
    const t00 = p.t0 || tIn; // real clock starts when the UI pressed Send
    const LABEL = { vision: "understanding the image", chat: "formulating response" };
    const sendStage = () => { if (!event.sender.isDestroyed()) event.sender.send("chat:token", { id: p.id, stage: LABEL[phase], timer: { phase, ms: Date.now() - t00, vision_ms: tVision || undefined } }); }; // one message per phase change; the window does the counting itself
    entry.stop = () => {};
    sendStage();
    const lastQ = p.messages[p.messages.length - 1].content;
    const describeQ = !!p.image && lastQ.length < 80 && /^\s*(what|whats|what's|describe|tell me|explain|show)\b[^?]{0,50}\b(image|picture|photo|pic|this|here|there|it)\b/i.test(lastQ);
    let sentTxt = "";
    const tidy = (t) => String(t).replace(/^\s*[-*•\d.)]+\s+/gm, "").replace(/\s*\n+\s*/g, " ").trim();
    const emit = (t) => { const c = tidy(t); if (c.length > sentTxt.length && c.startsWith(sentTxt) && !event.sender.isDestroyed()) { event.sender.send("chat:token", { id: p.id, text: c.slice(sentTxt.length) }); sentTxt = c; } }; // delta only, as the words are produced
    if (describeQ) { entry.streamAll = true; entry.generic = true; entry.noCut = true; entry.onPartial = emit; }
    if (p.image) {
      for (const [id, o] of active) if (id !== p.id && o.phase === "vision") { o.cancelled = true; if (o.req) o.req.destroy(); } // a stale vision job never competes with this one
      entry.phase = "vision";
      const tv = Date.now();
      const q = p.messages[p.messages.length - 1].content;
      if (!visionCache.has(vkey(p.conv, p.image.hash)) && !preCache.has(p.image.hash)) prefill(engine, buildMessages({ ...p, findings: "x" }).slice(0, -1)); // warm the chat prefix while the eye works
      const v = await readImage(engine, p.image, q, entry, logger, p.conv); // entry is the holder: Stop and new chats can abort it
      entry.phase = "chat"; phase = "chat";
      tVision = Date.now() - tv;
      if (entry.cancelled) { entry.stop(); active.delete(p.id); return { ok: true, type: "chat.stream", data: { text: "", cancelled: true } }; }
      if (!v.ok) { entry.stop(); active.delete(p.id); return err("VISION_FAILED", "Could not read the image: " + String(v.message || "unknown error")); }
      findings = v.text;
      sendStage(); // reading -> writing
    } else {
      for (const [id, o] of active) if (id !== p.id && o.phase === "vision") { o.cancelled = true; if (o.req) o.req.destroy(); } // a new text chat never waits behind an image job
    }
    if (describeQ) { // the eye's words ARE the answer: already streamed while it looked, nothing left to formulate
      const text = tidy(findings); emit(findings);
      if (sentTxt !== text && !event.sender.isDestroyed()) event.sender.send("chat:token", { id: p.id, text: text.startsWith(sentTxt) ? text.slice(sentTxt.length) : text });
      entry.stop(); active.delete(p.id);
      return { ok: true, type: "chat.stream", data: { text, findings, timings: { vision_ms: tVision || null, instant: true } } };
    }
    // 2) Chat AI answers from the findings only (the chat model gets no image data, so the prompt stays small and fast).
    const msgs = buildMessages({ ...p, findings });
    entry.prog = isProg(p.messages); // programming answers are never cut by SpeedX
    const bodyFor = (model) => JSON.stringify({ model, messages: msgs, stream: true, think: false, keep_alive: -1, options: { ...OPTIONS, ...(p.image ? { num_predict: 80 } : {}), ...(p.short && !entry.prog ? { num_predict: 120 } : {}), ...engine.RUNNER } });
    const tReady = Date.now();
    const runStream = (body) => new Promise((resolve) => {
      let text = "", first = null, buf = "", settled = false, tSent = 0, tHdr = null, tThink = null, thinkChars = 0, ollama = null;
      let pend = "", flushT = null, sentFirst = false;
      const flush = () => { if (flushT) { clearTimeout(flushT); flushT = null; } if (pend && !event.sender.isDestroyed()) event.sender.send("chat:token", { id: p.id, text: pend }); pend = ""; };
      const META = /^\s*(the user|user\b|okay,? the user|since the user|so,? the user|sure,? the user|i will\b|i'll acknowledge|i should\b|i need to\b|let me\b)/i; // the model talking about the user / its own plan instead of to them
      let gate = null, held = ""; // only an opening that could be such a leak is held for ~16 characters; every other answer streams at once
      const cleanMeta = (t) => { const q = /["\u201c]([^"\u201d]{2,})["\u201d]\s*[.!]?\s*$/.exec(t); if (q) return q[1]; return t.replace(/^[^.!?]*[.!?]\s*/, "") || "Okay, what would you like next?"; };
      const release = () => { if (!held) return; const h = held; held = ""; if (gate === "hold") { text = cleanMeta(h); send(text); } else send(h); };
      const queue = (s) => {
        if (gate === "free") return send(s);
        held += s;
        if (gate === null) { if (/^\s*(the|user|i|okay|ok|let|so|sure)\b/i.test(held) || !held.trim()) gate = "decide"; else { gate = "free"; const h = held; held = ""; return send(h); } }
        if (gate === "decide" && held.trim().length >= 16) { gate = META.test(held) ? "hold" : "free"; if (gate === "free") { const h = held; held = ""; send(h); } }
      };
      const send = (s) => { pend += s; if (!sentFirst) { sentFirst = true; flush(); } else if (!flushT) flushT = setTimeout(flush, 16); }; // first token at once, then one message per frame (16 ms)
      const finish = (result) => { if (settled) return; flush(); settled = true; entry.stop(); active.delete(p.id); resolve(result); };
      const done = () => {
        release();
        const timings = { // all in ms: UI->main IPC | engine check | prompt build+send | Ollama first byte | thinking (should be null) | first token | total | Ollama's own numbers
          ui_to_main_ms: p.t0 ? tIn - p.t0 : null, engine_check_ms: tReady - tIn, send_to_ollama_ms: tSent - tIn,
          vision_ms: tVision || null, ollama_headers_ms: tHdr && tSent ? tHdr - tSent : null, thinking_ms: tThink && tSent ? tThink - tSent : null, thinking_chars: thinkChars,
          first_token_ms: first, total_ms: Date.now() - tIn, since_send_ms: p.t0 ? Date.now() - p.t0 : null, ollama,
        };
        if (logger) logger.info(`chat ${p.id} ${JSON.stringify(timings)}`);
        finish({ ok: true, type: "chat.stream", data: { text: text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), cancelled: entry.cancelled || undefined, timings } });
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
          if (settled) return;
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let o; try { o = JSON.parse(line); } catch (_) { continue; }
            if (o.error) return finish(err("AI_ERROR", String(o.error).slice(0, 300)));
            if (entry.speedx && !entry.prog && !text.includes("```") && text && o.message && o.message.content) { const e = /[.!?]["')\]]?(\s*)$/.exec(text); if (e && (e[1] || /^\s/.test(o.message.content))) { done(); req.destroy(); return; } } // SpeedX pressed mid-answer: stop at the end of the sentence being written
            if (o.message && o.message.thinking) { thinkChars += o.message.thinking.length; if (tThink === null) tThink = Date.now(); } // reasoning would show up here
            let piece = (o.message && o.message.content) || "";
            if (piece) {
              if (!text) piece = piece.replace(/^\s+/, "");
              if (piece) {
                if (first === null) { first = Date.now() - tSent; entry.stop(); } // timing 4: first visible token
                text += piece;
                queue(piece);
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
      req.on("error", (e) => (entry.cancelled ? done() : finish(err("AI_UNAVAILABLE", `Cannot reach the local Ollama engine (${e.code || e.message}).`))));
      tSent = Date.now(); // timing 3: request to Ollama sent
      req.end(body);
    });
    const result = await runStream(bodyFor(engine.CHAT_MODEL));
    // 3) Memory: findings are handed back WITH the finished answer (only when complete, never partial); the UI saves them after displaying it.
    if (p.image && result.ok && result.data && result.data.text && !result.data.cancelled) result.data.findings = findings;
    else if (p.image) visionCache.delete(vkey(p.conv, p.image.hash)); // incomplete answer: do not keep findings
    if (visionCache.size > 8) visionCache.delete(visionCache.keys().next().value);
    return result;
  });

  let visionWarmStarted = false;
  const powerUpVision = () => { if (visionWarmStarted) return; visionWarmStarted = true; warmupChat({ engine, logger }).then(() => warmupVision({ engine, logger })).catch(() => { visionWarmStarted = false; }); }; // brain first, then the eye: they never load at the same time
  ipcMain.handle("chat:speedx", (event) => { // SpeedX pressed: answers being prepared or written right now end at the next sentence
    if (!isTrustedSender(event)) return null;
    powerUpVision();
    for (const o of active.values()) if (o.phase !== "prefetch") o.speedx = true;
    return { ok: true };
  });

  const generating = () => { for (const o of active.values()) if (o.phase !== "prefetch") return true; return false; };
  const waitIdle = async (maxMs = 180000) => { const t = Date.now(); while (generating() && Date.now() - t < maxMs) await new Promise((r) => setTimeout(r, 120)); }; // a refresh never runs while an answer is being produced
  ipcMain.handle("chat:refresh", async (event, raw) => { // SpeedX refresh: pre-fills the cache with system prompt + last exchange (1 token), the loaded model stays loaded
    if (!isTrustedSender(event)) return null;
    await waitIdle(); // SpeedX refresh waits until the answer in progress has fully finished
    powerUpVision();
    const m = (raw && Array.isArray(raw.messages) ? raw.messages : []).filter((x) => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string").slice(-2).map((x) => ({ role: x.role, content: x.content.slice(0, OLD_MSG_CHARS) }));
    const messages = buildMessages({ messages: m.length ? m : [{ role: "user", content: "Hi" }] });
    const ok = await new Promise((resolve) => {
      const req = http.request(engine.HOST + "/api/chat", { method: "POST", agent, headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode === 200)); res.on("error", () => resolve(false)); });
      req.on("error", () => resolve(false));
      req.setNoDelay(true);
      req.end(JSON.stringify({ model: engine.CHAT_MODEL, messages, stream: false, think: false, keep_alive: -1, options: { ...OPTIONS, num_predict: 1, ...engine.RUNNER } }));
    });
    return { ok };
  });

  ipcMain.handle("chat:findings", (event, conv, hash) => {
    if (isTrustedSender(event) && typeof conv === "string" && hash === undefined) return preCache.get(conv) || [...visionCache].reverse().find(([k]) => k.endsWith(":" + conv))?.[1] || ""; // preload passes only the hash // saved findings of an image for one conversation (instant, no waiting, no background work)
    if (!isTrustedSender(event) || typeof hash !== "string") return "";
    return visionCache.get(vkey(typeof conv === "string" ? conv.slice(0, 64) : "", hash)) || "";
  });
  return { warmup: () => warmupChat({ engine, logger }), warmupVision: () => warmupVision({ engine, logger }) };
}

// Forget everything cached about earlier images/conversations (used by "Clear all conversations").
function clearCaches() { visionCache.clear(); preCache.clear(); pfHolder.clear(); inflight.clear(); }

module.exports = { registerChatIpc, buildMessages, warmupChat, warmupVision, activeChats, clearCaches };
