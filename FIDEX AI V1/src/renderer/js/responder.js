// RESPONDER: the single place where chat replies come from.
// Replies are written by the local AI (Ollama, model qwen3.5:4b) through the Python backend
// ("chat.reply"). Recent conversation goes along with each question (older turns are shortened). Saved details
// (getBrainContext) are stored once in the backend's permanent memory; only matching memories are used.
// Past conversations are searched on demand only (js/recall.js).
// Simple questions about the user themselves are still answered instantly from those saved details.
// Outside the desktop app (plain browser preview) the old placeholder reply is shown.

import { FIELDS, profileSummary, greetingName } from "./profile.js";
import { loadProfile, loadConversations } from "./storage.js";
import { wantsPastChats, recallPastChats } from "./recall.js";
import { openMemoryPanel } from "./memory-panel.js";
import { isShort, windowStart, afterReply } from "./speedx.js";

// Direct link to the preload API (window.fidex -> Electron IPC -> Python). No extra JS layers in between.
const api = window.fidex || {};
const inElectron = Boolean(window.fidex);
const rpc = (type, payload) => (typeof api.backendRequest === "function" ? api.backendRequest(type, payload) : Promise.resolve({ ok: false, type, error: { code: "NOT_IN_ELECTRON", message: "The Python backend is only available in the desktop app." } }));

// chat.stream: Python prepares memory + prompt and streams from Ollama; chat.token events come back tagged with this stream_id.
let streamCounter = 0;
async function streamChat(payload, onToken, onStage, control) {
  const id = `s${Date.now().toString(36)}${++streamCounter}`;
  control.id = id; // lets stop() cancel exactly this answer
  let soFar = "";
  const off = typeof api.onBackendEvent === "function" ? api.onBackendEvent((evt) => {
    if (!evt || !evt.data || evt.data.stream_id !== id) return;
    if (evt.event === "chat.token" && typeof onToken === "function") { soFar += evt.data.text || ""; onToken(soFar); }
    else if (evt.event === "chat.stage" && typeof onStage === "function") onStage(String(evt.data.text || ""));
  }) : () => {};
  try {
    if (control.stopped) rpc("chat.cancel", { stream_id: id }); // Stop was pressed before the request left
    return await rpc("chat.stream", { ...payload, stream_id: id });
  } finally {
    off();
  }
}

// ---- Normal Chat fast path: window -> Electron main -> local Ollama (think:false). No Python, no extra model call. ----
const SCREEN_Q = /\b(screen|display|monitor|desktop|currently open|(what|which)\b.{0,40}\b(app|apps|application|applications|window|windows|program|tab)\b.{0,30}\b(open|running|active|showing|visible|using)|look at|can you see|what do you see|what am i (doing|looking))\b/i;
let streamCounter2 = 0;
async function streamDirect(payload, onToken, control, onStage) {
  const id = `d${Date.now().toString(36)}${++streamCounter2}`;
  control.id = id;
  control.direct = true;
  if (control.stopped) return { ok: true, data: { cancelled: true, text: "" } }; // Stop pressed before the request left
  let soFar = "";
  const off = api.onChatToken((evt) => {
    if (!evt || evt.id !== id) return;
    if (evt.stage) { if (typeof onStage === "function" && (!soFar || evt.stage.startsWith("build|"))) onStage(evt.stage); return; } // build| stages (image -> code) stay visible while code streams
    if (typeof onToken !== "function") return;
    if (!soFar) control.uiFirst = Date.now() - control.t0;
    soFar += evt.text || "";
    onToken(soFar);
  });
  try {
    return await api.chatStart({ ...payload, id, t0: control.t0 });
  } finally {
    off();
  }
}
// Findings of sent images arrive after the answer (main process, background). Follow-ups wait for them for at most 6 s.
export function fetchFindings(hash) { return typeof api.chatFindings === "function" ? api.chatFindings(hash).catch(() => "") : Promise.resolve(""); }
async function settleFindings(conversation) {
  const waiting = ((conversation && conversation.messages) || []).slice(-6).filter((m) => m && m.image && m.imageHash && !m.imageFindings);
  if (!waiting.length) return;
  await Promise.all(waiting.map((m) => Promise.race([fetchFindings(m.imageHash).then((t) => { if (t) m.imageFindings = t; }), new Promise((r) => setTimeout(r, 6000))])));
}
// What the brain gets alongside the user's message.
export function getBrainContext() {
  return profileSummary(loadProfile());
}

const ABOUT_ME = [
  { re: /\b(my name|who am i|call me)\b/i, keys: ["name", "preferredName"] },
  { re: /\b(my (job|role|title|work|profession)|what do i do)\b/i, keys: ["role", "company", "industry"] },
  { re: /\b(my (company|business|employer))\b/i, keys: ["company", "industry"] },
  { re: /\b(my (skills?|expertise)|what am i good at)\b/i, keys: ["skills"] },
  { re: /\b(my (ai )?tools?|which (ai )?tools? do i use)\b/i, keys: ["tools"] },
  { re: /\b(my (goals?|projects?)|what am i working on)\b/i, keys: ["goals"] },
  { re: /\b(where do i live|my (location|city|time ?zone))\b/i, keys: ["location"] },
  { re: /\b(what do you know about me|about me)\b/i, keys: FIELDS.map((f) => f.key) },
];

function answerFromDetails(userText, profile) {
  for (const rule of ABOUT_ME) {
    if (!rule.re.test(userText)) continue;
    const parts = rule.keys.filter((k) => profile[k]).map((k) => `${FIELDS.find((f) => f.key === k).label}: ${profile[k]}`);
    if (parts.length) return `From the details you gave me:\n${parts.join("\n")}`;
    return "I do not have that saved yet. You can add it under \"Give Me Your Details\".";
  }
  return null;
}

// The conversation as the AI should remember it: real exchanges only (no placeholder or error notices).
function memoryOf(conversation, userText) {
  const valid = ((conversation && conversation.messages) || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && !m.placeholder && !m.error && typeof m.text === "string" && m.text.trim());
  const from = windowStart(conversation && conversation.id), at = from ? valid.findIndex((m) => m.id === from) : -1; // SpeedX: after a refresh the AI sees only the window that started there
  const history = (at >= 0 ? valid.slice(at) : valid)
    .map((m) => ({ role: m.role, content: m.imageFindings ? `${m.text}\n[Image findings: ${m.imageFindings}]` : m.text }));
  const lastUser = history.length ? history[history.length - 1] : null;
  if (!history.length || lastUser.role !== "user" || !lastUser.content.startsWith(userText)) {
    history.push({ role: "user", content: userText });
  }
  return history.slice(-6); // Ollama re-reads all history on every message: only the last few turns go along
}

function placeholderReply(userText, profile) {
  const name = greetingName(profile);
  const preview = userText.length > 120 ? userText.slice(0, 120) + "..." : userText;
  return {
    placeholder: true,
    text:
      (name ? `${name}, this ` : "This ") +
      "is a placeholder reply. The SI brain only runs inside the FIDEX SI desktop app, " +
      "so no real SI wrote this message.\n\nYour message was received: \"" + preview + "\"",
  };
}

const FRIENDLY = {
  AI_UNAVAILABLE: "My SI engine is starting or reconnecting. FIDEX SI restarts it automatically; please send your message again in a few seconds.",
  AI_MODEL_MISSING: "The FIDEX SI model is being installed or was not found. FIDEX SI imports FIDEX-SI-Model-qwen3.5-4b.zip automatically from your Downloads folder; wait a moment and send your message again.",
  AI_TIMEOUT: "The SI took too long to answer. Please try again, or ask something shorter.",
};

// Model warm-up now happens in the Electron main process.
// Never blocks the interface; any failure is ignored (the first real question will just load it).
export function warmUp() {} // the Electron main process loads the model at startup (ollama-engine.js)


// The saved details only travel to the Python backend when they changed; the backend stores them in its
// permanent memory and gives the AI just the few memories that match each question.
let lastProfileSent = null;
export function resetChatState() { lastProfileSent = null; }
const inFlight = new Map(); // the same question sent twice (double click / Enter + button) shares one request

export function getReply(conversation, userText, onToken, onStage, image) {
  const key = `${(conversation && conversation.id) || ""}|${userText}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const control = { id: null, stopped: false, t0: Date.now() }; // timing 1: request start
  const p = getReplyInner(conversation, userText, onToken, onStage, control, image).then((r) => { if (r && r.text && !r.error && !r.stopped) setTimeout(() => { try { afterReply(conversation); } catch (e) {} }, 400); return r; }).finally(() => { // every finished reply counts toward SpeedX's automatic refresh (every 4)
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  // p.stop(): cancels this answer right away (Stop button) and frees the key so the same question can be sent again.
  p.stop = () => {
    inFlight.delete(key);
    control.stopped = true;
    if (!control.id) return Promise.resolve(null);
    return control.direct ? api.chatCancel(control.id) : rpc("chat.cancel", { stream_id: control.id });
  };
  inFlight.set(key, p);
  return p;
}

async function getReplyInner(conversation, userText, onToken, onStage, control, image) {
  if (!image && /^\/memory\b/i.test(userText.trim())) {
    openMemoryPanel();
    return { placeholder: false, text: "Here is everything I remember about you. You can edit or delete any item." };
  }
  const profile = loadProfile();

  if (!inElectron) return placeholderReply(userText, profile);

  if (typeof api.chatStart === "function" && (image || !SCREEN_Q.test(userText))) { // fast path (screen questions still use the Python path with the Eye)
    const direct = { messages: memoryOf(conversation, userText) };
    if (isShort()) direct.short = true; // SpeedX pressed: shortest possible answers
    if (image) direct.image = { data: image.data, hash: image.hash }; // the model looks at it once and answers straight away
    if (wantsPastChats(userText)) {
      try {
        direct.past_chats = recallPastChats(loadConversations(), userText, conversation && conversation.id);
      } catch (err) {
        console.warn("[FIDEX AI] past chat search failed", err);
      }
    }
    if (!image) await settleFindings(conversation); // a follow-up may need the findings of an image sent a moment ago (usually already done)
    const r = await streamDirect(direct, onToken, control, onStage);
    if (r.ok && r.data && r.data.cancelled) return { placeholder: false, stopped: true, text: "" };
    if (r.ok && r.data && r.data.text) {
      console.debug("[FIDEX AI timings]", { ...r.data.timings, ui_first_token_ms: control.uiFirst, ui_total_ms: Date.now() - control.t0 });
      return { placeholder: false, text: r.data.text, timings: r.data.timings, imageHash: image ? image.hash : undefined };
    }
    const c = r.error && r.error.code;
    return { placeholder: false, error: true, text: FRIENDLY[c] || `Sorry, I could not get an answer. ${(r.error && r.error.message) || "Unknown error."}` };
  }
  const summary = getBrainContext();
  const payload = { messages: memoryOf(conversation, userText), mode: "chat" }; // Normal Chat: backend sends only name + main project
  if (summary !== lastProfileSent) payload.profile = summary || "";
  // Past chats are searched only when the user asks about earlier conversations or decisions. "Hello" and new questions skip this.
  if (wantsPastChats(userText)) {
    try {
      payload.past_chats = recallPastChats(loadConversations(), userText, conversation && conversation.id);
    } catch (err) {
      console.warn("[FIDEX AI] past chat search failed", err);
    }
  }
  const res = await streamChat(payload, onToken, onStage, control);
  if (res.ok && res.data && res.data.cancelled) return { placeholder: false, stopped: true, text: "" }; // stopped by the user: partial text is dropped
  if (res.ok && res.data && res.data.text) {
    lastProfileSent = summary;
    if (res.data.timings) console.debug("[FIDEX AI timings]", res.data.timings);
    return { placeholder: false, text: res.data.text, timings: res.data.timings };
  }

  const code = res.error && res.error.code;
  if (code === "NOT_IN_ELECTRON") return placeholderReply(userText, profile);
  const detail = (res.error && res.error.message) || "Unknown error.";
  return { placeholder: false, error: true, text: FRIENDLY[code] || `Sorry, I could not get an answer. ${detail}` };
}
