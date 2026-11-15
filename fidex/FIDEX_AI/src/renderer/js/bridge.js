// Safe wrapper around the functions the Electron preload exposes as window.fidex.
// If the interface is opened without Electron (for example in a plain browser while testing),
// every call quietly does nothing, so the interface never crashes.

const api = window.fidex || {};
const call = (name, ...args) => (typeof api[name] === "function" ? api[name](...args) : Promise.resolve(null));

export const bridge = {
  inElectron: Boolean(window.fidex),
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
