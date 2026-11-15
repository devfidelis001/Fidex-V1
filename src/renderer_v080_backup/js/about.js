// About page: shows the app and runtime versions reported by Electron.

import { bridge } from "./bridge.js";

export function createAbout({ versionEl, electronEl, chromeEl }) {
  async function load() {
    try {
      const info = await bridge.getAppInfo();
      versionEl.textContent = info ? info.version : "unknown";
      electronEl.textContent = info ? info.electron : "not running in Electron";
      chromeEl.textContent = info ? info.chrome : "-";
    } catch (err) {
      versionEl.textContent = "unknown";
      electronEl.textContent = "unknown";
      chromeEl.textContent = "unknown";
    }
  }
  return { load };
}
