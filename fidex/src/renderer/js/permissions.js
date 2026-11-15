// Permissions page: shows what FIDEX AI needs (microphone, screen, browser, files), lets the user
// switch each one on or off, and requests the real browser/OS permission when one is switched on.
// A switch is FIDEX AI's own consent; the system may still ask or block (shown as the status).

import { loadPermissions, savePermissions } from "./storage.js";

export const PERMS = [
  { key: "microphone", label: "Microphone", why: "Voice commands and dictation. Not used yet, but needed when voice arrives.", icon: "i-mic" },
  { key: "screen", label: "Screen", why: "Lets FIDEX AI see your screen when you ask it to look at something. You choose what to share each time.", icon: "i-expand" },
  { key: "browser", label: "Browser", why: "Lets FIDEX AI open links and web pages in your browser and show notifications.", icon: "i-globe" },
  { key: "files", label: "Files", why: "Lets FIDEX AI read files and project folders you pick. It only sees what you choose.", icon: "i-paperclip" },
];

const STATUS_TEXT = {
  granted: "Allowed",
  denied: "Blocked by the system",
  prompt: "Will ask when used",
  off: "Off",
  unsupported: "Not supported here",
};

// Real system state where the platform can tell us. Returns "granted" | "denied" | "prompt" | "unsupported".
export async function systemState(key) {
  try {
    if (key === "microphone" && navigator.permissions) {
      return (await navigator.permissions.query({ name: "microphone" })).state;
    }
    if (key === "browser" && "Notification" in window) {
      return Notification.permission === "default" ? "prompt" : Notification.permission;
    }
    if (key === "screen" && window.fidex) return "granted"; // the Python eye captures the screen natively; Electron's getDisplayMedia is not used
    if (key === "screen") return navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia ? "prompt" : "unsupported";
    if (key === "files") return "granted"; // files are only reachable through a picker the user opens
  } catch (err) {
    // fall through
  }
  return key === "files" ? "granted" : "unsupported";
}

// Asks the system for the permission. Resolves to "granted" | "denied" | "unsupported".
export async function requestPermission(key) {
  try {
    if (key === "microphone") {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "unsupported";
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // permission check only, nothing is recorded
      return "granted";
    }
    if (key === "screen") {
      if (window.fidex) return "granted"; // native capture by the Python backend: no browser prompt needed (it fails in Electron without a handler)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return "unsupported";
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      return "granted";
    }
    if (key === "browser") {
      if (!("Notification" in window)) return "granted"; // opening links needs no system prompt
      const result = await Notification.requestPermission();
      return result === "granted" ? "granted" : "denied";
    }
    if (key === "files") return "granted";
  } catch (err) {
    return err && err.name === "NotFoundError" ? "unsupported" : "denied";
  }
  return "unsupported";
}

export function createPermissions({ listEl, resetEl, toast }) {
  let state = loadPermissions(); // {key: true|false} = the user's consent
  const rows = new Map();

  for (const p of PERMS) {
    const row = document.createElement("label");
    row.className = "switch-row perm-row";
    const info = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = p.label;
    const why = document.createElement("i");
    why.textContent = p.why;
    const status = document.createElement("i");
    status.className = "perm-status";
    info.append(title, why, status);
    const sw = document.createElement("input");
    sw.type = "checkbox";
    sw.className = "switch";
    sw.setAttribute("aria-label", p.label + " permission");
    row.append(info, sw);
    listEl.appendChild(row);
    rows.set(p.key, { sw, status });

    sw.addEventListener("change", async () => {
      if (!sw.checked) {
        state = { ...state, [p.key]: false };
        savePermissions(state);
        await refreshRow(p.key);
        return;
      }
      sw.disabled = true;
      const result = await requestPermission(p.key);
      sw.disabled = false;
      if (result === "granted") {
        state = { ...state, [p.key]: true };
        toast(`${p.label} allowed.`);
      } else {
        state = { ...state, [p.key]: false };
        toast(result === "denied" ? `${p.label} was blocked. Allow it in your system settings, then try again.` : `${p.label} is not available on this device.`);
      }
      savePermissions(state);
      await refreshRow(p.key);
    });
  }

  async function refreshRow(key) {
    const { sw, status } = rows.get(key);
    const sys = await systemState(key);
    // A blocked system permission overrides the stored consent.
    const on = Boolean(state[key]) && sys !== "denied" && sys !== "unsupported";
    sw.checked = on;
    sw.disabled = sys === "unsupported" && key !== "files" ? true : false;
    status.textContent = on ? STATUS_TEXT.granted : sys === "denied" ? STATUS_TEXT.denied : sys === "unsupported" ? STATUS_TEXT.unsupported : state[key] ? STATUS_TEXT[sys] || STATUS_TEXT.off : STATUS_TEXT.off;
  }

  async function load() {
    state = loadPermissions();
    for (const p of PERMS) await refreshRow(p.key);
  }

  resetEl.addEventListener("click", async () => {
    state = {};
    savePermissions(state);
    await load();
    toast("All FIDEX AI permissions were switched off.");
  });

  return { load, isAllowed: (key) => Boolean(state[key]) };
}
