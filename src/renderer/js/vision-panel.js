// Live Desktop Vision controls: Start / Pause / Resume / Stop and a live status line.
// The work happens in the Python backend (vision.py: DXcam capture + local Ollama). This file only sends the controls and shows
// the state. It is used on the Take Over page and in the Take Over panel; the screen is never sent anywhere but local Ollama.

import { bridge } from "./bridge.js";

export function createVisionControls({ startEl, pauseEl, resumeEl, stopEl, statusEl, textEl }) {
  let state = { state: "stopped" };
  let timer = null;

  const label = (s) => {
    if (s.error && s.state !== "running" && s.state !== "paused") return "Vision error";
    if (s.warm && s.warm.state === "loading") return "Eye warming up...";
    if (s.warm && s.warm.state === "error") return "Eye could not warm up";
    if (s.state === "running" && s.warm && s.warm.state === "ready") return "Eye ready";
    return { stopped: "Eye off", starting: "Eye opening...", running: "Eye open", paused: "Vision paused" }[s.state] || "Vision";
  };

  function render(s) {
    state = s || state;
    const on = state.state === "running" || state.state === "starting";
    const paused = state.state === "paused";
    if (startEl) startEl.hidden = on || paused;
    if (pauseEl) pauseEl.hidden = !on;
    if (resumeEl) resumeEl.hidden = !paused;
    if (stopEl) stopEl.hidden = !(on || paused);
    if (statusEl) {
      statusEl.textContent = state.error ? `${label(state)} - ${state.error.message}` : on && state.analysed ? `${label(state)} - ${state.analysed} looks, ${state.capture_fps || 0} fps capture` : label(state);
      statusEl.dataset.state = state.error ? "error" : state.state;
    }
    if (textEl) textEl.textContent = on || paused ? state.summary || "Looking at your screen..." : "";
    clearInterval(timer);
    timer = on || paused ? setInterval(refresh, 2500) : null; // the backend also pushes "vision.update"; this is only a safety net
  }

  async function send(type) {
    const r = await bridge.backendRequest(type, {});
    if (r.ok) render(r.data);
    else render({ state: "stopped", error: r.error || { message: "Vision request failed." } });
    return r;
  }

  async function refresh() {
    const r = await bridge.backendRequest("vision.status", {});
    if (r.ok) render(r.data);
  }

  startEl && startEl.addEventListener("click", () => send("vision.start"));
  pauseEl && pauseEl.addEventListener("click", () => send("vision.pause"));
  resumeEl && resumeEl.addEventListener("click", () => send("vision.resume"));
  stopEl && stopEl.addEventListener("click", () => send("vision.stop"));
  bridge.onBackendEvent((evt) => {
    if (evt && evt.event === "vision.update" && evt.data) render(evt.data);
  });
  render(state);
  refresh();
  return { refresh, render };
}
