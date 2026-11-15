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

export function loadProfile() {
  const data = readJson(PROFILE_KEY, {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}
export function saveProfile(profile) {
  writeJson(PROFILE_KEY, profile);
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
