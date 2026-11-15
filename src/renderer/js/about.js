// About page: version, release info, runtime versions and the Restart button.

import { bridge } from "./bridge.js";

export function createAbout({ versionEl, electronEl, chromeEl, restartEl }) {
  if (restartEl) {
    restartEl.addEventListener("click", async () => {
      if (!window.confirm("Restart FIDEX now? Your conversations are already saved.")) return;
      restartEl.disabled = true;
      restartEl.textContent = "Restarting...";
      const res = await bridge.backendRequest("app.restart", {});
      if (!res || !res.ok) {
        restartEl.disabled = false;
        restartEl.textContent = "Restart FIDEX";
        window.alert("Restart is only available in the desktop app.");
      }
    });
  }

  async function load() {
    versionEl.textContent = "Version 1";
    try {
      const info = await bridge.getAppInfo();
      electronEl.textContent = info ? info.electron : "not running in Electron";
      chromeEl.textContent = info ? info.chrome : "-";
    } catch (err) {
      electronEl.textContent = "unknown";
      chromeEl.textContent = "unknown";
    }
  }
  return { load };
}
