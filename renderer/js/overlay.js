// Take Over window: the logo circle and the activity panel.
// The panel shows the real state of the task (agent-core.js) and the real AI replies. Nothing is simulated.

import { bridge } from "./bridge.js";
import { createAgent, STEPS } from "./agent-core.js";
import { db } from "./db-client.js";
import { createProgressSaver } from "./progress-saver.js";
import { fromRestored } from "./progress-map.js";
import { createAgentAi } from "./agent-ai.js";
import { createHandsAgent } from "./hands-agent.js";
import { createVisionControls } from "./vision-panel.js";

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
  stepsHead: $("ov-steps-head"),
  log: $("ov-log"),
  outstanding: $("ov-outstanding"),
  stop: $("ov-stop"),
  pause: $("ov-pause"),
  resume: $("ov-resume"),
  controls: document.querySelector(".p-controls"),
  form: $("ov-form"),
  target: $("ov-target"),
  targetText: $("ov-target-text"),
  targetClear: $("ov-target-clear"),
  input: $("ov-input"),
  send: $("ov-send"),
};

createVisionControls({ statusEl: $("ov-vstatus") });

const DEFAULT_PLACEHOLDER = "Add information or an instruction...";
let panelHidden = false;
let detailsOpen = false;
let target = null; // request id, "general", or null (= first open question)
let seen = new Set();
let lastSync = "";
let current = null;

// Step 6: every change of the task is saved automatically (see progress-saver.js).
const saver = createProgressSaver({ stepIds: STEPS.map((s) => s.id) });
const sim = createAgent({
  onChange: (state) => {
    hands.onState(state);
    render(state);
    saver.queue(state);
  },
});

// Real AI (Ollama) for Take Over: answers the task and the user's messages.
const ai = createAgentAi("takeover");
const aiEl = document.createElement("p");
aiEl.className = "p-why";
aiEl.hidden = true;
const reasonEl = document.createElement("p"); // the model's real reasoning, shown while it works
reasonEl.className = "p-why";
reasonEl.hidden = true;
el.why.after(reasonEl);
reasonEl.after(aiEl);
let aiLive = false; // true while an answer is being streamed (render() must not overwrite it)

// Windows Hands (PyAutoGUI): when it is available, Qwen decides real mouse/keyboard actions for the task.
const hands = createHandsAgent({
  sim,
  say: (t) => deliver(t),
});

// A question from the agent becomes a question card (like an approval card), not a chat message. Anything before it stays a normal reply.
function deliver(text) {
  const m = /^([\s\S]*?)([^.!?\n]{6,}\?)["\u201d')\]\s]*$/.exec(String(text || "").trim());
  if (!m) return sim.reply(text);
  sim.reply(m[1].trim()); // empty clears the previous reply: the question lives only in its card
  sim.addRequest({ id: "q-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind: "info", text: m[2].trim(), placeholder: "Type your answer...", blocks: true });
}

// Every message goes through ONE queue and is handled in order, so a message sent while the task is running is never lost,
// never runs in parallel with the current work (no duplicated actions) and never starts a second clock.
const inbox = [];
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (inbox.length) {
      const item = inbox.shift();
      sim.setQueued(inbox.length);
      const s = sim.snapshot();
      if (!s || s.status === "stopped") break;
      await askAi(hands.pending() ? item.raw : item.text); // a big task waiting for the AI name needs the plain answer
    }
  } finally {
    pumping = false;
    inbox.length = 0;
    sim.setQueued(0);
    finishIfIdle();
  }
}
// In Take Over every message is an instruction to carry out (like the first one, which is labelled "Task:"), except plain conversation:
// a question, or a one-word reply. Without the label a follow-up such as "make a folder test2" was treated as chat and never reached the hands.
const ACT_VERB = /^(open|click|type|press|scroll|move|close|save|run|stop|wait|search|play|pause|check|select|choose|pick|go|add|edit|update|change|insert|continue|create|make|write|find|show|install|download|launch|start|use|work|put|fix|remove|delete|rename|copy|paste|build|set|switch|log|sign|navigate|finish|try|do|take|get|look|read|list|display|print|call|send|login|resume|go on|keep|now|then|also|and)\b/i;
function asTask(text) {
  const t = text.trim();
  if (/^task\s*:/i.test(t) || /^answer to "/i.test(t)) return t;
  const core = t.replace(/^(?:please|pls|hey|ok(?:ay)?|now|can you|could you|would you|will you|i want you to|i need you to|i would like you to|go ahead and|just)\s+/gi, "").replace(/^(?:please|pls)\s+/i, "");
  if (ACT_VERB.test(core)) return "Task: " + core; // anything that asks for an action is ALWAYS carried out by the hands, never answered by chat
  if (/\?\s*$/.test(t) || /^(what|why|how|who|when|where|which|is|are|tell me|explain)\b/i.test(t)) return t;
  if (t.split(/\s+/).length < 3) return t;
  return "Task: " + t;
}
function enqueue(text, raw = text) {
  inbox.push({ text, raw });
  sim.setQueued(pumping ? inbox.length : 0);
  pump();
}
function finishIfIdle() {
  const s = sim.snapshot();
  if (!s || s.status === "stopped" || s.requests.some((r) => r.state === "open" && r.kind === "info")) return;
  if (hands.failed()) return sim.complete("NOT completed: see the message above"); // never show Done for a task that did not succeed
  sim.complete(`Done in ${((Date.now() - s.startedAt) / 1000).toFixed(1)}s`);
}

async function askAi(text) {
  if (/^\s*task\s*:/i.test(text) || (await hands.available())) { // a task goes straight to the hands: no availability check in front of it
    const handled = await hands.run(text);
    if (handled === "chat") return chatAi(text); // no action needed: answer normally
    return handled;
  }
  if (/^\s*task\s*:/i.test(text)) { // a task is NEVER answered by chat: show why the hands are not available
    const st = await bridge.backendRequest("hands.status", {});
    const why = (st.ok && st.data && st.data.error && st.data.error.message) || (st.error && st.error.message) || "the backend did not answer";
    sim.setActivity("");
    return deliver(`Hands are not available: ${why}. Close the app completely and start it again.`);
  }
  return chatAi(text);
}

async function chatAi(text) {
  aiLive = true;
  aiEl.hidden = false;
  aiEl.textContent = "";
  reasonEl.hidden = true;
  reasonEl.textContent = "";
  sim.setActivity("Working..."); // the AI is answering
  const out = await ai.ask(
    text,
    (partial) => {
      aiEl.textContent = partial;
    },
    () => {} // no reasoning shown: thinking is off
  );
  aiLive = false;
  sim.setActivity("");
  if (out.cancelled) return;
  if (out.text) deliver(out.text); // final answer only
  else aiEl.textContent = out.error;
}

const timerEl = document.createElement("span"); // one timer for the WHOLE task: from the first click to Done
timerEl.style.cssText = "margin-left:8px;font-variant-numeric:tabular-nums;opacity:.85";
el.count.after(timerEl);
let frozenAt = null;
setInterval(() => {
  const s = current;
  if (!s || !s.startedAt) return;
  const over = s.status === "done" || s.status === "stopped";
  if (over && frozenAt === null) frozenAt = Date.now();
  if (!over) frozenAt = null;
  timerEl.textContent = (((over ? frozenAt : Date.now()) - s.startedAt) / 1000).toFixed(1) + "s · b14";
}, 100);
hands.available().catch(() => {}); // check Hands once at load so the first task does not wait for it

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------- Rendering ----------
function render(state) {
  current = state;
  const active = state.steps.find((s) => s.state === "active");
  const asking = state.requests.some((r) => r.state === "open" && r.kind === "info");
  const stage = state.status === "stopped" ? "Stopped" : state.paused ? "Paused" : state.status === "done" ? "Done" : asking ? "Waiting for your answer" : active ? active.label : "Working";

  el.stage.textContent = stage;
  el.count.textContent = state.queued ? ` +${state.queued} queued` : "";
  el.dot.className = "pdot" + (state.status === "waiting" ? " is-waiting" : state.status === "done" ? " is-done" : state.status === "stopped" ? " is-stopped" : "");
  el.task.textContent = state.task.text;
  el.task.title = state.task.text;
  el.doing.textContent = state.doing;
  el.why.textContent = state.why;
  if (!aiLive) {
    aiEl.hidden = !state.aiReply;
    aiEl.textContent = state.aiReply || "";
  }
  el.bar.hidden = state.progress == null; // no real progress is known, so no bar is shown
  el.fill.style.width = (state.progress || 0) + "%";
  el.bar.setAttribute("aria-valuenow", String(state.progress || 0));

  renderRequests(state);
  renderDetails(state);
  el.stop.hidden = state.status === "stopped";
  el.controls.hidden = state.status === "stopped" || state.status === "done";
  el.pause.hidden = state.paused;
  el.resume.hidden = !state.paused;
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
      stage,
      progress: state.progress || 0,
      outstanding: state.outstanding,
    });
  }
}

let reqSig = "";
function renderRequests(state) {
  const open = state.requests.filter((r) => r.state === "open");
  const sig = open.map((r) => r.id).join(",");
  if (sig === reqSig) return; // same cards: keep them (and what the user is typing in them) untouched
  reqSig = sig;
  el.requests.replaceChildren(
    ...open.map((r) => {
      const box = document.createElement("div");
      box.className = "req";
      box.dataset.id = r.id;
      box.innerHTML = `<span class="req-k">${r.kind === "approval" ? "Approval required" : "Question"}</span><span class="req-q"></span><p class="req-d"></p><div class="req-actions"></div>`;
      box.querySelector(".req-q").textContent = r.text;
      box.querySelector(".req-d").textContent = r.detail || "";
      const actions = box.querySelector(".req-actions");
      if (r.kind === "approval") {
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
      actions.remove();
      const row = document.createElement("form");
      row.className = "req-a";
      row.innerHTML = '<input type="text" autocomplete="off" /><button class="req-btn primary" type="submit">' + (String(r.id).startsWith("wait-") ? "Continue" : "Answer") + '</button>';
      const input = row.querySelector("input");
      input.placeholder = r.placeholder || "Type your answer...";
      input.setAttribute("aria-label", "Answer: " + r.text);
      row.addEventListener("submit", (e) => {
        e.preventDefault();
        const isWait = String(r.id).startsWith("wait-"); // "wait for me": the button is Continue and the agent carries on
        const text = input.value.trim() || (isWait ? "go" : "");
        if (!text || !sim.answer(r.id, text)) return;
        if (isWait && /^(go|continue|ok|okay|yes|done|proceed|resume|next|ready|go on)\b/i.test(text)) return;
        enqueue(`Answer to "${r.text}": ${text}`, text);
      });
      box.append(row);
      return box;
    })
  );
}

function renderDetails(state) {
  el.stepsHead.hidden = el.steps.hidden = state.steps.length === 0;
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
  const finished = state.status === "stopped";
  el.input.disabled = finished;
  el.input.placeholder = finished ? "This task was stopped." : state.status === "done" ? "Done. Send more instructions..." : DEFAULT_PLACEHOLDER;
  el.target.hidden = true;
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
el.pause.addEventListener("click", () => {
  hands.setPaused(true);
  sim.setPaused(true);
});
el.resume.addEventListener("click", () => {
  sim.setPaused(false);
  hands.setPaused(false);
});
el.close.addEventListener("click", () => {
  inbox.length = 0;
  ai.stop();
  hands.stop();
  sim.stop();
  bridge.closeOverlay();
});
el.stop.addEventListener("click", () => {
  inbox.length = 0;
  ai.stop();
  hands.stop();
  sim.stop();
});
el.targetClear.addEventListener("click", () => {
  target = "general";
  render(current);
  el.input.focus();
});
el.input.addEventListener("input", () => syncInput(current));
document.addEventListener("keydown", (e) => {
});

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = el.input.value.trim();
  if (!text || !current) return;
  sim.note(text); // shows at once in the activity log; the queue hands it to FIDEX in order
  enqueue(asTask(text), text);
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
  inbox.length = 0;
  hands.reset();
  reqSig = "";
  seen = new Set();
  lastSync = "";
  target = null;
  setPanelHidden(false);
  setDetails(false);
  ai.reset();
  aiEl.hidden = true;
  aiEl.textContent = "";
  reasonEl.hidden = true;
  reasonEl.textContent = "";
  sim.start(task);
  sim.setActivity("Setting the steps..."); // no idle "Ready" stage: the work starts now
  enqueue(`Task: ${task.text}`);
}

// Continue a task that was saved before FIDEX AI closed. Only what the database holds is restored.
async function resumeTask(task) {
  const resumed = await db.work.resume(task.id);
  const restored = resumed.ok ? await db.work.restore() : resumed;
  const entry = restored.ok ? restored.data.tasks.find((t) => t.task.id === task.id) : null;
  if (!entry) return startTask(task); // nothing usable was saved: start it again from the instruction
  inbox.length = 0;
  hands.reset();
  reqSig = "";
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
