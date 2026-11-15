// Safe wrapper around the functions the Electron preload exposes as window.fidex.
// If the interface is opened without Electron (for example in a plain browser while testing),
// every call quietly does nothing, so the interface never crashes.

const api = window.fidex || {};
const call = (name, ...args) => (typeof api[name] === "function" ? api[name](...args) : Promise.resolve(null));

// Python backend calls always resolve to {ok:true,type,data} or {ok:false,type,error:{code,message}}.
const noBackend = (type, code, message) => ({ ok: false, type: type || null, error: { code, message } });
async function backendRequest(type, payload) {
  if (typeof api.backendRequest !== "function") {
    return noBackend(type, "NOT_IN_ELECTRON", "The Python backend is only available in the desktop app.");
  }
  try {
    const res = await api.backendRequest(type, payload);
    return res && typeof res.ok === "boolean" ? res : noBackend(type, "BAD_RESPONSE", "The backend answered in an unexpected format.");
  } catch (err) {
    return noBackend(type, "IPC_FAILED", String((err && err.message) || err));
  }
}

export const bridge = {
  inElectron: Boolean(window.fidex),
  backendRequest,
  getBackendStatus: () => call("getBackendStatus"),
  onBackendStatus: (callback) => (typeof api.onBackendStatus === "function" ? api.onBackendStatus(callback) : () => {}),
  getAppInfo: () => call("getAppInfo"),
  minimize: () => call("minimizeWindow"),
  toggleMaximize: () => call("toggleMaximizeWindow"),
  close: () => (api.closeWindow ? api.closeWindow() : window.close()),
  // Take Over window (logo circle + activity panel)
  openOverlay: (task, options) => call("openOverlay", task, options),
  closeOverlay: () => call("closeOverlay"),
  expandOverlay: () => call("expandOverlay"),
  resizeOverlay: (size) => call("resizeOverlay", size),
  sendOverlayUpdate: (update) => call("sendOverlayUpdate", update),
  onOverlayTask: (callback) => {
    if (typeof api.onOverlayTask === "function") api.onOverlayTask(callback);
  },
  onOverlayEvent: (callback) => {
    if (typeof api.onOverlayEvent === "function") api.onOverlayEvent(callback);
  },
  onWindowState: (callback) => {
    if (typeof api.onWindowState === "function") api.onWindowState(callback);
  },
};
