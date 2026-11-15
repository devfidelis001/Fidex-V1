// User profile in the EXISTING FIDEX SQLite file (<userData>/db/fidex.sqlite). One singleton row
// (id = 1), so updates never create duplicates. Persists across restarts. Uses Node's built-in sqlite.
const path = require("path");
const fs = require("fs");

const COLS = { name: "full_name", role: "occupation", tools: "ai_tools", about: "profile_info", goals: "current_project", convoMgmt: "conversation_management" };
let db = null;

function open(userDataDir) {
  if (db) return db;
  const { DatabaseSync } = require("node:sqlite");
  const dir = path.join(userDataDir, "db");
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "fidex.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    full_name TEXT NOT NULL DEFAULT '',
    occupation TEXT NOT NULL DEFAULT '',
    ai_tools TEXT NOT NULL DEFAULT '',
    profile_info TEXT NOT NULL DEFAULT '',
    current_project TEXT NOT NULL DEFAULT '',
    conversation_management INTEGER NOT NULL DEFAULT 0,
    extra TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT ''
  )`);
  return db;
}

function getProfile(dir) {
  const row = open(dir).prepare("SELECT * FROM user_profile WHERE id = 1").get();
  if (!row) return null;
  let extra = {};
  try { extra = JSON.parse(row.extra) || {}; } catch (e) { /* ignore */ }
  const out = { ...extra };
  for (const [k, c] of Object.entries(COLS)) if (row[c] !== "" && row[c] !== 0) out[k] = k === "convoMgmt" ? "yes" : row[c];
  if (!row.conversation_management && extra.convoMgmt === "no") out.convoMgmt = "no";
  return out;
}

// Replaces the stored profile with the given one (single row upsert).
function saveProfile(dir, p) {
  const prof = p && typeof p === "object" ? p : {};
  const extra = {};
  for (const [k, v] of Object.entries(prof)) if (!COLS[k] && typeof v === "string") extra[k] = v.slice(0, 2000);
  if (prof.convoMgmt === "no") extra.convoMgmt = "no";
  const s = (k) => String(prof[k] ?? "").slice(0, 2000);
  open(dir).prepare(`INSERT INTO user_profile (id, full_name, occupation, ai_tools, profile_info, current_project, conversation_management, extra, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, occupation=excluded.occupation, ai_tools=excluded.ai_tools,
      profile_info=excluded.profile_info, current_project=excluded.current_project,
      conversation_management=excluded.conversation_management, extra=excluded.extra, updated_at=excluded.updated_at`)
    .run(s("name"), s("role"), s("tools"), s("about"), s("goals"), prof.convoMgmt === "yes" ? 1 : 0, JSON.stringify(extra), new Date().toISOString());
  return getProfile(dir);
}

function registerProfileIpc({ ipcMain, session, userDataDir, preloadPath, isTrusted }) {
  const guard = (fn) => (event, ...a) => {
    try {
      if (isTrusted && !isTrusted(event)) return { ok: false, error: "untrusted" };
      return { ok: true, data: fn(...a) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };
  ipcMain.handle("profile:get", guard(() => getProfile(userDataDir)));
  ipcMain.handle("profile:save", guard((p) => saveProfile(userDataDir, p)));
  // Adds window.fidexProfile to every renderer without touching the existing preload.
  session.registerPreloadScript({ type: "frame", filePath: preloadPath });
}

module.exports = { registerProfileIpc, getProfile, saveProfile };
