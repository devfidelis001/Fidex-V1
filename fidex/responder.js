// RESPONDER: the single place where chat replies come from.
// Replies are written by the local AI (Ollama, model qwen3:4b) through the Python backend
// ("chat.reply"). The whole conversation so far is sent every time, so the AI remembers it, and the
// details saved under "Give Me Your Details" (getBrainContext) go along with every question.
// Simple questions about the user themselves are still answered instantly from those saved details.
// Outside the desktop app (plain browser preview) the old placeholder reply is shown.

import { FIELDS, profileSummary, greetingName } from "./profile.js";
import { loadProfile } from "./storage.js";
import { bridge } from "./bridge.js";

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

export async function getReply(conversation, userText) {
  const profile = loadProfile();
  const known = answerFromDetails(userText, profile);
  if (known) return { placeholder: false, text: known };

  if (!bridge.inElectron) return placeholderReply(userText, profile);

  const res = await bridge.backendRequest("chat.reply", { messages: memoryOf(conversation, userText), profile: getBrainContext() });
  if (res.ok && res.data && res.data.text) return { placeholder: false, text: res.data.text };

  const code = res.error && res.error.code;
  if (code === "NOT_IN_ELECTRON") return placeholderReply(userText, profile);
  const detail = (res.error && res.error.message) || "Unknown error.";
  return { placeholder: false, error: true, text: FRIENDLY[code] || `Sorry, I could not get an answer. ${detail}` };
}
