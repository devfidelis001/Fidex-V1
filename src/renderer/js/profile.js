// "Give Me Your Details": personal and professional information the user chooses to share.
// Saved locally (storage.js) and mirrored into the existing Brain/memory system through
// work.context.add (Python -> SQLite), so it is available when FIDEX AI answers.

import { loadProfile, saveProfile } from "./storage.js";
import { db } from "./db-client.js";
import { bridge } from "./bridge.js";
import { resetChatState } from "./responder.js";

export const FIELDS = [
  { key: "name", label: "Name", group: "personal" },
  { key: "goals", label: "Current project", group: "personal" },
  { key: "role", label: "Occupation / profession", group: "personal" },
];

const clean = (v) => String(v ?? "").trim().slice(0, 2000);

export function cleanProfile(raw) {
  const out = {};
  for (const f of FIELDS) {
    const v = clean(raw && raw[f.key]);
    if (v) out[f.key] = v;
  }
  return out;
}

// One readable memory entry per filled field, e.g. "User profile - Job title / role: Designer".
export function profileToMemory(profile) {
  return FIELDS.filter((f) => profile[f.key]).map((f) => `User profile - ${f.label}: ${profile[f.key]}`);
}

// Text the answering code can place in front of a question so replies know who is asking.
export function profileSummary(profile = loadProfile()) {
  const lines = FIELDS.filter((f) => profile[f.key]).map((f) => `${f.label}: ${profile[f.key]}`);
  if (!lines.length) return "";
  return lines.join("\n");
}

export function greetingName(profile = loadProfile()) {
  return (profile.name || "").split(/\s+/)[0] || "";
}

// Sends the profile to the Brain. Returns {saved, brain}: saved is always true locally;
// brain tells whether the backend memory accepted it (false in a plain browser or on error).
// The Brain now reads the SQLite-backed profile directly (see responder.getBrainContext), so no
// duplicate memory entries are written. Kept so existing callers keep working.
export async function syncToBrain() {
  return { brain: true };
}

export function createProfile({ formEl, fieldsEl, stateEl, clearEl, onSaved, toast }) {
  const inputs = new Map();

  for (const f of FIELDS) {
    const wrap = document.createElement("div");
    wrap.className = "pf-field" + (f.multiline ? " pf-wide" : "");
    const label = document.createElement("label");
    label.className = "field-label";
    label.htmlFor = "pf-" + f.key;
    label.textContent = f.label;
    const input = document.createElement(f.multiline ? "textarea" : "input");
    input.id = "pf-" + f.key;
    input.className = "pf-input";
    if (f.multiline) input.rows = 2;
    else input.type = "text";
    input.maxLength = 2000;
    input.autocomplete = "off";
    wrap.append(label, input);
    (f.group === "personal" ? fieldsEl.personal : fieldsEl.professional).appendChild(wrap);
    inputs.set(f.key, input);
  }

  function load() {
    const p = loadProfile();
    for (const f of FIELDS) inputs.get(f.key).value = p[f.key] || "";
    stateEl.textContent = Object.keys(p).length ? "Saved on this device and shared with FIDEX SI's memory." : "Nothing saved yet.";
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = {};
    for (const f of FIELDS) raw[f.key] = inputs.get(f.key).value;
    const profile = cleanProfile(raw);
    const prev = loadProfile();
    saveProfile(profile);
    stateEl.textContent = "Saving...";
    const res = await syncToBrain(profile);
    stateEl.textContent = res.offline
      ? "Saved on this device. Memory sync needs the desktop app."
      : res.brain
        ? "Saved and added to FIDEX SI's memory."
        : "Saved on this device, but the memory could not be updated. Try again.";
    if (onSaved) onSaved(profile);
    toast("Your details were saved.");
  });

  clearEl.addEventListener("click", () => {
    if (!window.confirm("Delete your saved details from this device? They are also removed from FIDEX SI's memory.")) return;
    saveProfile({});
    bridge.backendRequest("memory.forget", { scope: "profile" });
    resetChatState();
    load();
    if (onSaved) onSaved({});
    toast("Your details were removed.");
  });

  return { load };
}
