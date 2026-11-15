// Take Over agent shell: the state of one assigned task, and the small API the panel talks to.
//
// This file executes nothing and invents nothing. It only holds what is really known: the task, what the
// user said, the AI's real replies (see agent-ai.js) and whatever the real agent reports through the setters.
//
// EXTENSION POINTS for the real Take Over system (its "hands") when it is connected:
//   setActivity(text, why)   what is genuinely being done now
//   setProgress(percent|null)  real progress; null hides the bar
//   setSteps([{id,label,state}])  real plan steps; state: pending | active | done
//   addRequest({id,kind:"info"|"approval",text,detail,placeholder,blocks})  a real question or approval
//   complete(summary)        the task really finished
// The user-facing calls (answer, decide, note, stop) are how replies reach the real agent.
// The same state is what progress-saver.js stores, so tasks can continue after a restart.

export const STEPS = []; // no predefined steps: the real agent supplies them

export function createAgent({ onChange }) {
  let state = null;
  const emit = () => state && onChange(JSON.parse(JSON.stringify(state)));

  function log(text) {
    state.log.push({ time: Date.now(), text });
    if (state.log.length > 30) state.log.shift();
  }

  const fresh = (task) => ({
    task: { id: task.id, text: task.text },
    status: "idle", // idle (nothing running) | working | waiting | done | stopped. "done" is NOT final: new messages make the task work again
    startedAt: Date.now(), // the ONE clock of the task: every elapsed time is measured from here, a new message never resets it
    paused: false, // actions are held; thinking and planning continue
    queued: 0, // messages waiting behind the one being handled
    phase: 0,
    progress: null,
    doing: "",
    why: "",
    steps: [],
    requests: [],
    log: [],
    outstanding: [],
    notes: [],
  });

  function start(task) {
    state = fresh(task);
    log("Assignment received.");
    emit();
  }

  // Continue a task saved before FIDEX AI closed (see progress-map.fromRestored). Restores what was saved; runs nothing.
  function resume(saved) {
    state = fresh(saved.task);
    if (saved.startedAt) state.startedAt = saved.startedAt;
    state.progress = saved.progress || null;
    state.steps = saved.steps || [];
    state.requests = saved.requests.map((r) => ({ blocks: false, placeholder: "Your answer", ...r }));
    const stamp = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : "an earlier session";
    log(`Continuing from saved progress (last saved ${stamp}). Work after that point was not saved.`);
    for (const text of saved.reopened || []) log(`Approval needed again: ${text}`);
    emit();
  }

  function setActivity(doing, why = "") {
    if (!state || state.status === "stopped") return;
    if (!doing && state.status === "done") return; // finished stays finished until real work starts again
    if (doing && state.status === "done") state.progress = null; // new work after Done: the old 100% no longer applies
    state.doing = doing;
    state.why = why;
    state.status = doing ? "working" : "idle";
    emit();
  }
  function setProgress(pct) {
    if (!state) return;
    state.progress = pct == null ? null : Math.max(0, Math.min(100, pct));
    emit();
  }
  function setSteps(steps) {
    if (!state) return;
    state.steps = steps;
    emit();
  }
  function addRequest(req) {
    if (!state || state.requests.some((r) => r.id === req.id)) return;
    state.requests.push({ blocks: false, placeholder: "Your answer", ...req, state: "open", answer: null });
    log(req.kind === "approval" ? `Approval needed: ${req.text}` : `Asked: ${req.text}`);
    emit();
  }
  // The work reached Done. The task stays ACTIVE: the user can still send more and it picks up from here.
  function complete(summary = "") {
    if (!state || state.status === "stopped") return;
    const bad = /^not completed/i.test(summary);
    state.status = "done";
    state.doing = summary || "Done";
    state.why = "";
    if (!bad) { state.progress = 100; state.steps = state.steps.map((s) => ({ ...s, state: "done" })); }
    log("Done. Still here for more instructions.");
    emit();
  }

  function setPaused(flag) {
    if (!state || state.status === "stopped" || state.paused === Boolean(flag)) return;
    state.paused = Boolean(flag);
    log(state.paused ? "Actions paused. Thinking and planning continue." : "Actions resumed.");
    emit();
  }
  function setQueued(n) {
    if (!state || state.queued === n) return;
    state.queued = n;
    emit();
  }

  function answer(id, text) {
    const r = state && state.requests.find((x) => x.id === id && x.state === "open" && x.kind === "info");
    if (!r) return false;
    r.state = "answered";
    r.answer = text;
    log(`You answered: ${r.text}`);
    emit();
    return true;
  }

  function decide(id, approved) {
    const r = state && state.requests.find((x) => x.id === id && x.state === "open" && x.kind === "approval");
    if (!r) return false;
    r.state = "answered";
    r.answer = approved ? "approved" : "declined";
    log(approved ? `You approved: ${r.text}` : `You declined: ${r.text}`);
    emit();
    return true;
  }

  function note(text) {
    if (!state) return;
    state.notes.push({ time: Date.now(), text });
    log(`You added: ${text}`);
    emit();
  }

  // The AI's final answer. Shown in the panel and kept in the task log; reasoning is never included.
  function reply(text) {
    if (!state) return;
    state.aiReply = String(text || "").slice(0, 2000); // empty text clears the reply (used when the reply became a question card)
    if (state.aiReply) log("FIDEX AI: " + state.aiReply.slice(0, 300));
    emit();
  }

  function stop() {
    if (!state || state.status === "stopped") return;
    state.status = "stopped";
    state.paused = false;
    state.queued = 0;
    state.doing = "Stopped by you";
    state.why = "";
    log("Stopped by you.");
    emit();
  }

  return { start, resume, setPaused, setQueued, setActivity, setProgress, setSteps, addRequest, complete, answer, decide, note, reply, stop, dispose() {}, snapshot: () => (state ? JSON.parse(JSON.stringify(state)) : null) };
}
