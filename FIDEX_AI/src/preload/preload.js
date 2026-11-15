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
});
