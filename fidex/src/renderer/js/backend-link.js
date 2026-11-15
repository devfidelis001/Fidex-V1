// Link to the Python backend (Step 4: communication test only, no AI).
// The interface sends a structured request through the preload bridge; the Python backend
// answers; the result is returned (and written to the developer console). Nothing is drawn
// on screen: the interface is unchanged.

import { bridge } from "./bridge.js";

export const HELLO_TEXT = "Hello from FIDEX AI";

export async function checkBackendConnection({ log = console, text = HELLO_TEXT } = {}) {
  if (!bridge.inElectron) {
    log.info("[backend] Not running inside the desktop app, so the Python backend is not used.");
    return { ok: false, skipped: true };
  }
  const res = await bridge.backendRequest("hello", { message: text });
  if (res.ok) {
    log.info(`[backend] Python replied: "${res.data.reply}" (brain connected: ${res.data.brain_connected})`);
  } else if (res.error.code === "NOT_IN_ELECTRON") {
    log.info("[backend] " + res.error.message);
  } else {
    log.warn(`[backend] Python backend request failed: ${res.error.code} - ${res.error.message}`);
  }
  return res;
}
