// Local storage for FIDEX AI. Uses the browser's localStorage for now (no database yet).
// Everything that saves or loads data goes through this file,
// so it can be swapped for a real database in a later step.

const KEY = "fidex.conversations.v1";
const COMMANDS_KEY = "fidex.takeover.v1";
const SETTINGS_KEY = "fidex.settings.v1";

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage unavailable or full: the app keeps working for this session.
  }
}

// ---------- Conversations (unchanged behaviour) ----------
export function loadConversations() {
  const data = readJson(KEY, []);
  return Array.isArray(data) ? data : [];
}

export function saveConversations(list) {
  writeJson(KEY, list);
}

// Short, meaningful title taken from the first user message (used for new chats and the sidebar).
export function makeTitle(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  t = t.split(/(?<=[.!?])\s|\n/)[0]; // first sentence only
  const filler = /^(?:(?:hey|hi|hello|please|kindly|ok|okay|so|fidex(?: ai)?)[,!]?\s+)*(?:(?:can|could|would|will) you (?:please )?|i (?:want|need|would like|'d like) (?:you )?to |i(?:'| a)?m trying to |help me (?:to )?|tell me |show me |let'?s )/i;
  t = t.replace(filler, "").replace(/[?!.,:;\s]+$/, "").trim();
  if (!t) t = String(text).trim();
  const MAX = 32;
  if (t.length > MAX) {
    const cut = t.slice(0, MAX + 1);
    const sp = cut.lastIndexOf(" ");
    t = (sp > 14 ? cut.slice(0, sp) : t.slice(0, MAX)).replace(/[,;:\-\s]+$/, "") + "\u2026";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- Take Over instructions (history of what was sent) ----------
export function loadCommands() {
  const data = readJson(COMMANDS_KEY, []);
  return Array.isArray(data) ? data : [];
}

export function saveCommands(list) {
  writeJson(COMMANDS_KEY, list.slice(0, 100));
}

// ---------- Interface settings ----------
const DEFAULT_SETTINGS = { autoCompact: true, compactOnTop: true };

export function loadSettings() {
  const data = readJson(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...(data && typeof data === "object" ? data : {}) };
}

export function saveSettings(settings) {
  writeJson(SETTINGS_KEY, settings);
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- v0.9.0: personal details, permissions, Guide Me plans ----------
const PROFILE_KEY = "fidex.profile.v1";
const PERMS_KEY = "fidex.permissions.v1";
const PLANS_KEY = "fidex.guide.v1";

// Profile lives in the existing SQLite database (via window.fidexProfile). An in-memory cache keeps
// loadProfile() synchronous for existing callers; initProfile() fills it at startup.
let profileCache = {};
const pApi = () => window.fidexProfile || null;

export async function initProfile() {
  const api = pApi();
  if (!api) {
    profileCache = readJson(PROFILE_KEY, {}) || {}; // plain-browser fallback only
    return profileCache;
  }
  try {
    const res = await api.get();
    if (res && res.ok && res.data) profileCache = res.data;
    else {
      // One-time migration of a profile saved by older versions in localStorage.
      const legacy = readJson(PROFILE_KEY, null);
      if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
        profileCache = legacy;
        await api.save(legacy);
      }
    }
  } catch (err) {
    /* keep empty cache */
  }
  return profileCache;
}
export function loadProfile() {
  return { ...profileCache };
}
export function saveProfile(profile) {
  const next = { ...(profile && typeof profile === "object" ? profile : {}) };
  if (profileCache._onboarded && !next._onboarded) next._onboarded = profileCache._onboarded;
  profileCache = next;
  const api = pApi();
  if (api) api.save(next).catch(() => {});
  else writeJson(PROFILE_KEY, next);
}
export function loadPermissions() {
  const data = readJson(PERMS_KEY, {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}
export function savePermissions(perms) {
  writeJson(PERMS_KEY, perms);
}
export function loadPlans() {
  const data = readJson(PLANS_KEY, []);
  return Array.isArray(data) ? data : [];
}
export function savePlans(plans) {
  writeJson(PLANS_KEY, plans.slice(0, 200));
}

// ---------- Research & Problem Solving: the last finished research run ----------
const RESEARCH_KEY = "fidex.research.v1";
export function loadResearch() {
  const data = readJson(RESEARCH_KEY, null);
  return data && typeof data === "object" && !Array.isArray(data) ? data : null;
}
export function saveResearch(run) {
  writeJson(RESEARCH_KEY, run);
}
