// Take Over window: the logo circle and the activity panel.
// The panel is driven by the SIMULATED agent in agent-sim.js. Nothing is executed.

import { bridge } from "./bridge.js";
import { createAgentSim, STEPS } from "./agent-sim.js";
import { db } from "./db-client.js";
import { createProgressSaver } from "./progress-saver.js";
import { fromRestored } from "./progress-map.js";
import { createAgentAi } from "./agent-ai.js";

const $ = (id) => document.getElementById(id);
const el = {
  root: $("ov"),
  orb: $("ov-orb"),
  panel: $("ov-panel"),
  dot: $("ov-dot"),
  stage: $("ov-stage"),
  count: $("ov-count"),
  more: $("ov-more"),
  open: $("ov-open"),
  hide: $("ov-hide"),
  close: $("ov-close"),
  task: $("ov-task"),
  doing: $("ov-doing"),
  why: $("ov-why"),
  bar: document.querySelector(".p-bar"),
  fill: $("ov-fill"),
  requests: $("ov-requests"),
  details: $("ov-details"),
  steps: $("ov-steps"),
  log: $("ov-log"),
  outstanding: $("ov-outstanding"),
  stop: $("ov-stop"),
  form: $("ov-form"),
  target: $("ov-target"),
  targetText: $("ov-target-text"),
  targetClear: $("ov-target-clear"),
  input: $("ov-input"),
  send: $("ov-send"),
};

const DEFAULT_PLACEHOLDER = "Add information or an instruction...";
let panelHidden = false;
let detailsOpen = false;
let target = null; // request id, "general", or null (= first open question)
let seen = new Set();
let lastSync = "";
let current = null;

// Step 6: every change of the task is saved automatically (see progress-saver.js).
const saver = createProgressSaver({ stepIds: STEPS.map((s) => s.id) });
const sim = createAgentSim({
  onChange: (state) => {
    render(state);
    saver.queue(state);
  },
});

// Real AI (Ollama) for Take Over: answers the task and the user's messages. The step flow around it is still simulated.
const ai = createAgentAi("takeover");
const aiEl = document.createElement("p");
aiEl.className = "p-why";
aiEl.hidden = true;
el.why.after(aiEl);
let aiLive = false; // true while an answer is being streamed (render() must not overwrite it)

async function askAi(text) {
  aiLive = true;
  aiEl.hidden = false;
  aiEl.textContent = "FIDEX AI is thinking...";
  const out = await ai.ask(text, (partial) => {
    aiEl.textContent = partial;
  });
  aiLive = false;
  if (out.text) sim.reply(out.text); // final answer only
  else aiEl.textContent = out.error;
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------- Rendering ----------
function render(state) {
  current = state;
  const step = STEPS[state.phase];

  el.stage.textContent = state.status === "stopped" ? "Stopped" : state.status === "done" ? "Complete" : step.label;
  el.count.textContent = state.status === "done" || state.status === "stopped" ? "" : `${state.phase + 1} / ${STEPS.length - 1}`;
  el.dot.className = "pdot" + (state.status === "waiting" ? " is-waiting" : state.status === "done" ? " is-done" : state.status === "stopped" ? " is-stopped" : "");
  el.task.textContent = state.task.text;
  el.task.title = state.task.text;
  el.doing.textContent = state.doing;
  el.why.textContent = state.why;
  if (!aiLive && state.aiReply) {
    aiEl.hidden = false;
    aiEl.textContent = state.aiReply;
  }
  el.fill.style.width = state.progress + "%";
  el.bar.setAttribute("aria-valuenow", String(state.progress));

  renderRequests(state);
  renderDetails(state);
  el.stop.hidden = state.status === "done" || state.status === "stopped";
  syncInput(state);

  const openRequests = state.requests.filter((r) => r.state === "open");
  const fresh = openRequests.filter((r) => !seen.has(r.id));
  fresh.forEach((r) => seen.add(r.id));
  if (fresh.length && panelHidden) setPanelHidden(false); // a new question brings the panel back
  el.orb.classList.toggle("has-request", panelHidden && openRequests.length > 0);

  // Tell the main window about meaningful changes so History can show the outcome.
  const key = [state.status, state.phase, state.requests.map((r) => r.state).join("")].join("|");
  if (key !== lastSync) {
    lastSync = key;
    bridge.sendOverlayUpdate({
      id: state.task.id,
      status: state.status,
      stage: step.label,
      progress: state.progress,
      outstanding: state.outstanding,
    });
  }
}

function renderRequests(state) {
  const open = state.requests.filter((r) => r.state === "open");
  const infoOpen = open.filter((r) => r.kind === "info");
  const effective = target === "general" ? null : infoOpen.find((r) => r.id === target) || infoOpen[0] || null;

  el.requests.replaceChildren(
    ...open.map((r) => {
      if (r.kind === "approval") {
        const box = document.createElement("div");
        box.className = "req";
        box.innerHTML = '<span class="req-k">Approval required</span><span class="req-q"></span><p class="req-d"></p><div class="req-actions"></div>';
        box.querySelector(".req-q").textContent = r.text;
        box.querySelector(".req-d").textContent = r.detail || "";
        const actions = box.querySelector(".req-actions");
        const approve = document.createElement("button");
        approve.type = "button";
        approve.className = "req-btn primary";
        approve.textContent = "Approve";
        approve.addEventListener("click", () => sim.decide(r.id, true));
        const decline = document.createElement("button");
        decline.type = "button";
        decline.className = "req-btn";
        decline.textContent = "Decline";
        decline.addEventListener("click", () => sim.decide(r.id, false));
        actions.append(approve, decline);
        return box;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "req" + (effective && effective.id === r.id ? " is-target" : "");
      btn.innerHTML = '<span class="req-k">Needs your input</span><span class="req-q"></span>';
      btn.querySelector(".req-q").textContent = r.text;
      btn.addEventListener("click", () => {
        target = r.id;
        render(current);
        el.input.focus();
      });
      return btn;
    })
  );
}

function renderDetails(state) {
  el.steps.replaceChildren(
    ...state.steps.map((s) => {
      const li = document.createElement("li");
      li.className = s.state;
      li.textContent = s.label;
      return li;
    })
  );
  el.log.replaceChildren(
    ...state.log
      .slice(-6)
      .reverse()
      .map((entry) => {
        const li = document.createElement("li");
        const time = document.createElement("time");
        time.textContent = clock(entry.time);
        const text = document.createElement("span");
        text.textContent = entry.text;
        li.append(time, text);
        return li;
      })
  );
  const out = state.outstanding;
  el.outstanding.hidden = out.length === 0 || !(state.status === "done" || state.status === "stopped");
  if (!el.outstanding.hidden) {
    el.outstanding.replaceChildren();
    const h = document.createElement("b");
    h.textContent = "Outstanding";
    el.outstanding.append(h, ...out.map((t) => Object.assign(document.createElement("div"), { textContent: t })));
  }
}

function syncInput(state) {
  const infoOpen = state.requests.filter((r) => r.state === "open" && r.kind === "info");
  const active = target === "general" ? null : infoOpen.find((r) => r.id === target) || infoOpen[0] || null;
  const finished = state.status === "done" || state.status === "stopped";
  el.input.disabled = finished;
  el.input.placeholder = finished ? "This task has finished." : active ? active.placeholder : DEFAULT_PLACEHOLDER;
  el.target.hidden = !active;
  if (active) el.targetText.textContent = `Replying to: ${active.text}`;
  el.send.disabled = finished || el.input.value.trim() === "";
}

// ---------- Panel visibility ----------
function setPanelHidden(hidden) {
  panelHidden = hidden;
  el.root.classList.toggle("panel-hidden", hidden);
  el.orb.setAttribute("aria-expanded", String(!hidden));
  if (!hidden) el.orb.classList.remove("has-request");
}

function setDetails(open) {
  detailsOpen = open;
  el.details.hidden = !open;
  el.more.setAttribute("aria-expanded", String(open));
  el.more.title = open ? "Hide task details" : "Task details";
}

// ---------- Events ----------
el.orb.addEventListener("click", () => setPanelHidden(!panelHidden));
el.orb.addEventListener("dblclick", () => bridge.expandOverlay());
el.hide.addEventListener("click", () => setPanelHidden(true));
el.more.addEventListener("click", () => setDetails(!detailsOpen));
el.open.addEventListener("click", () => bridge.expandOverlay());
el.close.addEventListener("click", () => {
  sim.stop();
  bridge.closeOverlay();
});
el.stop.addEventListener("click", () => sim.stop());
el.targetClear.addEventListener("click", () => {
  target = "general";
  render(current);
  el.input.focus();
});
el.input.addEventListener("input", () => syncInput(current));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setPanelHidden(true);
});

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.input.value.trim();
  if (!text || !current) return;
  const infoOpen = current.requests.filter((r) => r.state === "open" && r.kind === "info");
  const active = target === "general" ? null : infoOpen.find((r) => r.id === target) || infoOpen[0] || null;
  if (active) {
    sim.answer(active.id, text);
    target = null;
    askAi(`Answer to "${active.text}": ${text}`);
  } else {
    sim.note(text);
    askAi(text);
  }
  el.input.value = "";
  syncInput(sim.snapshot());
});

// ---------- Window size follows the content, so the circle and panel never sit in a larger box ----------
new ResizeObserver(() => {
  const r = el.root.getBoundingClientRect();
  bridge.resizeOverlay({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
}).observe(el.root);

// ---------- Start ----------
function startTask(task) {
  seen = new Set();
  lastSync = "";
  target = null;
  setPanelHidden(false);
  setDetails(false);
  ai.reset();
  aiEl.hidden = true;
  aiEl.textContent = "";
  sim.start(task);
  askAi(`Task: ${task.text}`);
}

// Continue a task that was saved before FIDEX AI closed. Only what the database holds is restored.
async function resumeTask(task) {
  const resumed = await db.work.resume(task.id);
  const restored = resumed.ok ? await db.work.restore() : resumed;
  const entry = restored.ok ? restored.data.tasks.find((t) => t.task.id === task.id) : null;
  if (!entry) return startTask(task); // nothing usable was saved: start it again from the instruction
  seen = new Set();
  lastSync = "";
  target = null;
  setPanelHidden(false);
  setDetails(false);
  sim.resume(fromRestored(entry));
}

bridge.onOverlayTask((task) => (task.resume ? resumeTask(task) : startTask(task)));
const fromUrl = new URLSearchParams(location.search).get("task");
if (fromUrl) startTask({ id: "url", text: fromUrl });
