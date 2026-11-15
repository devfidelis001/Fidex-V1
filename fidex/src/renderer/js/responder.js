// RESPONDER: the single place where chat replies come from.
// Replies are written by the local AI (Ollama, model qwen3:4b) through the Python backend
// ("chat.reply"). Recent conversation goes along with each question (older turns are shortened). Saved details
// (getBrainContext) are stored once in the backend's permanent memory; only matching memories are used.
// Simple questions about the user themselves are still answered instantly from those saved details.
// Outside the desktop app (plain browser preview) the old placeholder reply is shown.

import { FIELDS, profileSummary, greetingName } from "./profile.js";
import { loadProfile } from "./storage.js";
import { bridge } from "./bridge.js";
import { streamRequest } from "./stream.js";
import { openMemoryPanel } from "./memory-panel.js";

// What the brain gets alongside the user's message.
export function getBrainContext() {
  return profileSummary(loadProfile());
}

const ABOUT_ME = [
  { re: /\b(my name|who am i|call me)\b/i, keys: ["name", "preferredName"] },
  { re: /\b(my (job|role|title|work|profession)|what do i do)\b/i, keys: ["role", "company", "industry"] },
  { re: /\b(my (company|business|employer))\b/i, keys: ["company", "industry"] },
  { re: /\b(my (skills?|expertise)|what am i good at)\b/i, keys: ["skills"] },
  { re: /\b(my (goals?|projects?))\b/i, keys: ["goals"] },
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

// Relevant full permanent memory for Take Over ("takeover") and Guide Me ("guide"); Normal Chat never uses this.
export async function getAgentContext(mode, query) {
  const res = await bridge.backendRequest("agent.context", { mode, query: String(query || "") });
  return res.ok && res.data ? res.data.text || "" : "";
}

// The conversation as the AI should remember it: real exchanges only (no placeholder or error notices).
function memoryOf(conversation, userText) {
  const history = ((conversation && conversation.messages) || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && !m.placeholder && !m.error && typeof m.text === "string" && m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }));
  if (!history.length || history[history.length - 1].role !== "user" || history[history.length - 1].content !== userText) {
    history.push({ role: "user", content: userText });
  }
  return history;
}

function placeholderReply(userText, profile) {
  const name = greetingName(profile);
  const preview = userText.length > 120 ? userText.slice(0, 120) + "..." : userText;
  return {
    placeholder: true,
    text:
      (name ? `${name}, this ` : "This ") +
      "is a placeholder reply. The AI brain only runs inside the FIDEX AI desktop app, " +
      "so no real AI wrote this message.\n\nYour message was received: \"" + preview + "\"",
  };
}

const FRIENDLY = {
  AI_UNAVAILABLE: "I cannot reach my AI engine. Please start Ollama (open the Ollama app, or run \"ollama serve\"), then send your message again.",
  AI_MODEL_MISSING: "My AI model is not installed yet. Run this once in a terminal, then try again:\n\nollama pull qwen3:4b",
  AI_TIMEOUT: "The AI took too long to answer. Please try again, or ask something shorter.",
};

// Loads the AI model into memory in the background at startup, so the first question is not slow.
// Never blocks the interface; any failure is ignored (the first real question will just load it).
let warmed = false;
export function warmUp() {
  if (warmed || !bridge.inElectron) return;
  warmed = true;
  setTimeout(() => {
    bridge.backendRequest("ai.warmup", {}).catch(() => {});
  }, 0);
}
warmUp();

// The saved details only travel to the Python backend when they changed; the backend stores them in its
// permanent memory and gives the AI just the few memories that match each question.
let lastProfileSent = null;
const inFlight = new Map(); // the same question sent twice (double click / Enter + button) shares one request

export function getReply(conversation, userText, onToken, onStage) {
  const key = `${(conversation && conversation.id) || ""}|${userText}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = getReplyInner(conversation, userText, onToken, onStage).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function getReplyInner(conversation, userText, onToken, onStage) {
  if (/^\/memory\b/i.test(userText.trim())) {
    openMemoryPanel();
    return { placeholder: false, text: "Here is everything I remember about you. You can edit or delete any item." };
  }
  const profile = loadProfile();
  const known = answerFromDetails(userText, profile);
  if (known) return { placeholder: false, text: known };

  if (!bridge.inElectron) return placeholderReply(userText, profile);

  const summary = getBrainContext();
  const payload = { messages: memoryOf(conversation, userText), mode: "chat" }; // Normal Chat: backend sends only name + main project
  if (summary !== lastProfileSent) payload.profile = summary || "";
  const res = await streamRequest(payload, onToken, onStage);
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
