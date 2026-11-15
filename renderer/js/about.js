// About page: app and runtime versions reported by Electron, plus the developer link.

import { bridge } from "./bridge.js";

const DEVELOPER_URL = "https://fidelisfrancis.pages.dev/";

export function createAbout({ versionEl, electronEl, chromeEl, developerEl }) {
  if (developerEl) {
    developerEl.addEventListener("click", (e) => {
      e.preventDefault();
      bridge.openExternal(DEVELOPER_URL);
    });
  }

  async function load() {
    try {
      const info = await bridge.getAppInfo();
      versionEl.textContent = info ? info.version : "0.9.0";
      electronEl.textContent = info ? info.electron : "not running in Electron";
      chromeEl.textContent = info ? info.chrome : "-";
    } catch (err) {
      versionEl.textContent = "0.9.0";
      electronEl.textContent = "unknown";
      chromeEl.textContent = "unknown";
    }
  }
  return { load };
}
