const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fidexProfile", {
  get: () => ipcRenderer.invoke("profile:get"),
  save: (profile) => ipcRenderer.invoke("profile:save", profile),
});
