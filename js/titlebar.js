// Custom window controls (the window has no native frame).

import { bridge } from "./bridge.js";

export function createTitlebar({ minEl, maxEl, maxUseEl, closeEl, menuEl, onMenu }) {
  minEl.addEventListener("click", () => bridge.minimize());
  maxEl.addEventListener("click", () => bridge.toggleMaximize());
  closeEl.addEventListener("click", () => bridge.close());
  menuEl.addEventListener("click", onMenu);

  bridge.onWindowState((state) => {
    const maximized = Boolean(state && state.maximized);
    maxUseEl.setAttribute("href", maximized ? "#i-restore" : "#i-maximize");
    maxEl.setAttribute("aria-label", maximized ? "Restore" : "Maximise");
    maxEl.title = maximized ? "Restore" : "Maximise";
  });
}
