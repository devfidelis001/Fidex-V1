"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// The only things the interface is allowed to call. Keep this list small.
contextBridge.exposeInMainWorld("fidex", {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  getTheme: () => ipcRenderer.invoke("theme:get"),
  onThemeChanged: (callback) =>
    ipcRenderer.on("theme:changed", (_event, theme) => callback(theme)),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  onWindowState: (callback) =>
    ipcRenderer.on("window:state", (_event, state) => callback(state)),

  // Take Over window: a separate transparent window holding the logo circle and activity panel
  openOverlay: (task, options) => ipcRenderer.invoke("overlay:open", task, options),
  closeOverlay: () => ipcRenderer.invoke("overlay:close"),
  expandOverlay: () => ipcRenderer.invoke("overlay:expand"),
  resizeOverlay: (size) => ipcRenderer.invoke("overlay:resize", size),
  sendOverlayUpdate: (update) => ipcRenderer.invoke("overlay:update", update),
  onOverlayTask: (callback) => ipcRenderer.on("overlay:task", (_event, task) => callback(task)),
  onOverlayEvent: (callback) => ipcRenderer.on("overlay:event", (_event, evt) => callback(evt)),

  // Python backend (Step 4). backendRequest always resolves with {ok:true,type,data} or
  // {ok:false,type,error:{code,message}}; it never rejects.
  backendRequest: async (type, payload) => {
    try {
      return await ipcRenderer.invoke("backend:request", type, payload);
    } catch (err) {
      return {
        ok: false,
        type: typeof type === "string" ? type : null,
        error: { code: "IPC_FAILED", message: String((err && err.message) || err) },
      };
    }
  },
  // Normal Chat: straight to the local Ollama engine (Take Over / Guide Me keep using backendRequest).
  chatStart: async (payload) => {
    try {
      return await ipcRenderer.invoke("chat:start", payload);
    } catch (err) {
      return { ok: false, type: "chat.stream", error: { code: "IPC_FAILED", message: String((err && err.message) || err) } };
    }
  },
  chatWake: () => ipcRenderer.invoke("chat:wake"),
  brainStatus: () => ipcRenderer.invoke("brain:status"),
  onBrainStatus: (callback) => {
    const listener = (_event, st) => callback(st);
    ipcRenderer.on("brain:status", listener);
    return () => ipcRenderer.removeListener("brain:status", listener);
  },
  chatRefresh: (payload) => ipcRenderer.invoke("chat:refresh", payload),
  chatSpeedX: () => ipcRenderer.invoke("chat:speedx"),
  chatFindings: (hash) => ipcRenderer.invoke("chat:findings", hash),
  chatCancel: (id) => ipcRenderer.invoke("chat:cancel", id),
  onChatToken: (callback) => {
    const listener = (_event, evt) => callback(evt);
    ipcRenderer.on("chat:token", listener);
    return () => ipcRenderer.removeListener("chat:token", listener);
  },
  getBackendStatus: async () => {
    try {
      return await ipcRenderer.invoke("backend:status");
    } catch (err) {
      return null;
    }
  },
  onBackendEvent: (callback) => {
    const listener = (_event, evt) => callback(evt);
    ipcRenderer.on("backend:event", listener);
    return () => ipcRenderer.removeListener("backend:event", listener);
  },
  onBackendStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("backend:status-changed", listener);
    return () => ipcRenderer.removeListener("backend:status-changed", listener);
  },
});
