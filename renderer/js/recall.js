// On-demand past-conversation memory.
// Past chats are searched ONLY when the user asks about earlier conversations, questions or decisions
// ("what did we decide about the logo?", "continue where we left off"). Ordinary messages such as "Hello" or a
// brand-new question never trigger a search. The search reads the conversations that are already saved by
// storage.js (the same store History and the sidebar use); nothing is copied or stored a second time.
// This file has no DOM or app imports, so it can be tested on its own (tests/recall.test.mjs).

const PAST = "(?:previous|earlier|past|prior|last|old|other|that|our)";
const CHAT = "(?:chats?|conversations?|discussions?|sessions?|threads?|talks?)";
const TALK = "(?:talk(?:ed)?|spoke|speak|discuss(?:ed)?|chat(?:ted)?|decid(?:e|ed)|agree(?:d)?|conclude(?:d)?|plan(?:ned)?|said|say|told|tell|mention(?:ed)?|ask(?:ed)?|suggest(?:ed)?|recommend(?:ed)?|propos(?:e|ed)|chose|choose|pick(?:ed)?|settle(?:d)?|write|wrote)";
const WHEN = "(?:earlier|before|previously|yesterday|last (?:time|night|week|month|session)|the other day|a (?:while|moment) ago|recently)";

// Each pattern needs a clear reference to the past, so questions like "what is a decision tree?" do not match.
const INTENT = [
  new RegExp(`\\b${PAST}\\s+${CHAT}\\b`, "i"), // "our previous conversation", "last chat"
  new RegExp(`\\b(?:in|from|during)\\s+(?:a|an|the|our|my)?\\s*${CHAT}\\b.*\\b(?:before|earlier|ago|yesterday|last)\\b`, "i"),
  new RegExp(`\\bwhat\\s+(?:did|have|had|were|was)\\s+(?:we|you|i)\\b.*\\b${TALK}\\b`, "i"), // "what did we decide about..."
  new RegExp(`\\bwhat\\s+(?:was|is)\\s+(?:the|our|my)\\s+(?:decision|plan|conclusion|agreement|answer)\\b.*\\b(?:we|you|i|earlier|before|last)\\b`, "i"),
  new RegExp(`\\b(?:did|do)\\s+(?:we|you|i)\\s+(?:ever\\s+)?${TALK}\\b`, "i"), // "did we talk about..."
  new RegExp(`\\b(?:we|you and i|you|i)\\s+(?:already\\s+|previously\\s+|once\\s+)?${TALK}\\b.*\\b${WHEN}\\b`, "i"), // "we discussed X yesterday"
  new RegExp(`\\b${WHEN}\\b.*\\b(?:we|you and i|you|i)\\s+(?:already\\s+)?${TALK}\\b`, "i"), // "yesterday we talked about"
  new RegExp(`\\b(?:as|like)\\s+(?:we|i|you)\\s+(?:already\\s+)?(?:discussed|said|talked|agreed|decided|planned|mentioned)\\b`, "i"),
  new RegExp(`\\b(?:remind me|recall|remember)\\b.*\\b(?:we|you|i)\\b.*\\b${TALK}\\b`, "i"),
  new RegExp(`\\b(?:remind me|recall)\\b.*\\b(?:what|which|how)\\b.*\\b${WHEN}\\b`, "i"),
  new RegExp(`\\b(?:continue|resume|pick up|carry on|go back to)\\b.*\\b(?:where we (?:left|stopped)|${CHAT}|from (?:before|earlier|yesterday|last)|we (?:were|started|began))`, "i"),
  /\bwhere (?:we|i) (?:left off|stopped)\b/i,
  new RegExp(`\\b(?:you|we)\\s+(?:said|told me|suggested|recommended|mentioned|promised)\\b.*\\b${WHEN}\\b`, "i"),
  new RegExp(`\\b${WHEN}\\b.*\\byou\\s+(?:said|told me|suggested|recommended|mentioned)\\b`, "i"),
  /\bour (?:earlier|previous|last|past|old) (?:chat|conversation|discussion|talk|session|plan|decision)/i,
];

export function wantsPastChats(text) {
  const t = String(text || "").trim();
  if (t.length < 8 || t.startsWith("/")) return false;
  return INTENT.some((re) => re.test(t));
}

const CONTINUE = /\b(?:continue|resume|pick up|carry on|go back to|where we (?:left|stopped))\b/i;
export const wantsContinue = (text) => CONTINUE.test(String(text || ""));

// ---------- search ----------
const STOP = new Set(
  ("the and for you your with that this have has what who how are was were can could would should about from into just like tell give make get does did not but all any out our its his her they them then than too very " +
    "we i me my us it is in on at to of a an be do if so or as by up no yes " +
    "talk talked talking discuss discussed discussing chat chatted conversation conversations discussion session thread " +
    "decide decided decision agree agreed said say told mention mentioned ask asked asking earlier before previously yesterday today last time week month night ago " +
    "previous past prior recall remind remember continue resume pick carry left stopped again also please there here which when where").split(/\s+/)
);

export function tokens(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().match(/[a-z0-9À-ɏ][a-z0-9À-ɏ'-]{2,}/g) || []) {
    if (STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}

const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// "yesterday", "today", "last week" narrow the search to that time. If nothing matches the window, all chats are searched.
function timeWindow(text, now) {
  const DAY = 86400000;
  const today = startOfDay(now);
  if (/\byesterday\b|\blast night\b/i.test(text)) return [today - DAY, today];
  if (/\btoday\b|\bearlier today\b/i.test(text)) return [today, today + DAY];
  if (/\blast week\b/i.test(text)) return [today - 14 * DAY, today - 0 * DAY];
  if (/\blast month\b/i.test(text)) return [today - 62 * DAY, today];
  return null;
}

const usable = (m) => m && (m.role === "user" || m.role === "assistant") && !m.placeholder && !m.error && typeof m.text === "string" && m.text.trim();
const clip = (s, n) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n).trimEnd() + "...";
};
const fmtDate = (t) => new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

export const MAX_RECALL_CHARS = 2200; // must stay under the backend limit (MAX_PAST_CHARS)
const MAX_HITS = 3;

function block(conv, msgs, perMsg) {
  const lines = msgs.map((m) => `${m.role === "user" ? "User" : "FIDEX AI"}: ${clip(m.text, perMsg)}`);
  return `Chat "${conv.title}" (${fmtDate(conv.updatedAt)}):\n${lines.join("\n")}`;
}

/**
 * Finds the past messages that match what the user is asking about.
 * Returns the text that is sent to the AI as "earlier conversations". Always returns a string; when nothing
 * matches it says so, so the AI answers honestly instead of guessing.
 */
export function recallPastChats(conversations, query, excludeId = null, now = Date.now()) {
  const q = String(query || "");
  let pool = (Array.isArray(conversations) ? conversations : []).filter((c) => c && c.id !== excludeId && Array.isArray(c.messages) && c.messages.some(usable));
  const win = timeWindow(q, now);
  if (win) {
    const inWin = pool.filter((c) => (c.updatedAt || 0) >= win[0] && (c.updatedAt || 0) < win[1]);
    if (inWin.length) pool = inWin;
  }
  if (!pool.length) return "No earlier conversations were found.";

  const want = tokens(q);
  const wide = wantsContinue(q);
  const scored = [];
  for (const c of pool) {
    const msgs = c.messages.filter(usable);
    const titleHits = [...tokens(c.title)].filter((w) => want.has(w)).length;
    msgs.forEach((m, i) => {
      const hits = [...tokens(m.text)].filter((w) => want.has(w)).length;
      if (hits + titleHits === 0 || hits === 0 && titleHits === 0) return;
      scored.push({ c, msgs, i, score: hits * 2 + titleHits, t: c.updatedAt || 0 });
    });
  }

  let out = [];
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score || b.t - a.t);
    const seen = new Set();
    for (const s of scored) {
      const key = s.c.id + ":" + Math.floor(s.i / 2);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= MAX_HITS) break;
    }
    if (wide) { // "continue where we left off about X": the end of the best-matching chat, in order
      const best = out[0];
      out = [{ c: best.c, tail: best.msgs.slice(-8) }];
    }
  } else if (want.size === 0 || wide) { // no topic given ("what did we talk about yesterday?"): the most recent chat
    const latest = [...pool].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    out = [{ c: latest, tail: latest.messages.filter(usable).slice(-8) }];
  } else {
    return "No earlier conversation matched that. Do not guess: say you could not find it in the saved chats.";
  }

  const parts = [];
  let used = 0;
  for (const s of out) {
    const msgs = s.tail || s.msgs.slice(Math.max(0, s.i - (s.msgs[s.i].role === "assistant" ? 1 : 0)), Math.max(0, s.i - (s.msgs[s.i].role === "assistant" ? 1 : 0)) + 2);
    const text = block(s.c, msgs, s.tail ? 260 : 420);
    if (used + text.length > MAX_RECALL_CHARS) {
      if (parts.length) break;
      parts.push(text.slice(0, MAX_RECALL_CHARS));
      break;
    }
    parts.push(text);
    used += text.length;
  }
  return parts.join("\n\n");
}
