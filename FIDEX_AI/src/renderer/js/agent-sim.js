// SIMULATED agent workflow for the Take Over panel.
//
// This is NOT an AI and executes nothing. It plays a scripted sequence so the interface for
// stages, questions, approvals and user input can be designed and tested now. When the real
// agent exists (a later step), it replaces this file and talks to the panel through the same
// small API: start(), answer(), decide(), note(), stop(), and the onChange(state) callback.
//
// Workflow: understand -> identify needs -> plan -> carry out approved tasks -> report -> complete.
// Questions never stop the whole task: the work continues while they are open, and only the step
// that truly depends on an answer waits. Consequential actions always need an approval.

export const STEPS = [
  { id: "understand", label: "Understand the objective", doing: "Understanding the objective", why: "Reading your brief to work out the result you want and what success looks like." },
  { id: "needs", label: "Identify what is needed", doing: "Identifying information and resources", why: "Listing the details, files and accounts the work will depend on." },
  { id: "plan", label: "Plan the work", doing: "Planning the work", why: "Ordering the tasks, and marking which need your approval first." },
  { id: "execute", label: "Carry out approved tasks", doing: "Carrying out approved tasks", why: "Working through the plan. Anything with real-world consequences waits for you." },
  { id: "report", label: "Report progress", doing: "Reporting progress", why: "Summarising what was done and what is still open." },
  { id: "done", label: "Completion and open issues", doing: "Finished", why: "" },
];

const PCT = [8, 22, 40, 58, 92, 100];
const PHASE_MS = [1800, 2000, 2200, 0, 1600];

const SEED_REQUESTS = [
  { id: "r-folder", kind: "info", raisedAt: 1, text: "Where is the project folder?", placeholder: "Folder path, for example D:\\Projects\\MySite", blocks: true },
  { id: "r-audience", kind: "info", raisedAt: 2, text: "Who is the target audience?", placeholder: "A short description of who this is for", blocks: false },
  { id: "r-account", kind: "info", raisedAt: 2, text: "Which social media account should be used?", placeholder: "Account name or link", blocks: false },
  { id: "a-publish", kind: "approval", raisedAt: 3, text: "Publish the finished draft to the live site?", detail: "Publishing is an external commitment. It will not happen without your approval.", blocks: true },
];

export function createAgentSim({ onChange }) {
  let timers = [];
  let tick = null;
  let state = null;

  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
    clearInterval(tick);
    tick = null;
  };

  const emit = () => onChange(snapshot());

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function log(text) {
    state.log.push({ time: Date.now(), text });
    if (state.log.length > 30) state.log.shift();
  }

  function open(kind) {
    return state.requests.filter((r) => r.state === "open" && (!kind || r.kind === kind));
  }

  function setPhase(i) {
    state.phase = i;
    const step = STEPS[i];
    state.steps = STEPS.map((s, idx) => ({ id: s.id, label: s.label, state: idx < i ? "done" : idx === i ? "active" : "pending" }));
    state.doing = step.doing;
    state.why = step.why;
    state.progress = Math.max(state.progress, PCT[i] - (i === 3 ? 18 : 0));
    // raise any questions scheduled for this phase
    for (const seed of SEED_REQUESTS) {
      if (seed.raisedAt === i && !state.requests.some((r) => r.id === seed.id)) {
        state.requests.push({ ...seed, state: "open", answer: null });
        log(seed.kind === "approval" ? `Approval needed: ${seed.text}` : `Asked: ${seed.text}`);
      }
    }
    log(step.doing);
  }

  function schedule(i) {
    if (i >= PHASE_MS.length) return;
    if (STEPS[i].id === "execute") {
      // Execution climbs slowly while it waits for anything that blocks it.
      tick = setInterval(() => {
        if (state.status === "stopped") return;
        const blockers = open().filter((r) => r.blocks);
        if (blockers.length === 0) {
          clearInterval(tick);
          tick = null;
          finishExecution();
          return;
        }
        state.progress = Math.min(state.progress + 1, 84);
        state.status = "waiting";
        state.doing = "Preparing work while waiting for you";
        state.why = `Waiting on: ${blockers.map((b) => (b.kind === "approval" ? "your approval" : b.text.replace(/\?$/, ""))).join("; ")}.`;
        emit();
      }, 700);
      return;
    }
    timers.push(
      setTimeout(() => {
        if (state.status === "stopped") return;
        setPhase(i + 1);
        emit();
        schedule(i + 1);
      }, PHASE_MS[i])
    );
  }

  function finishExecution() {
    state.status = "working";
    const declined = state.requests.some((r) => r.kind === "approval" && r.answer === "declined");
    if (declined) {
      state.outstanding.push("Publishing was declined, so the draft stays unpublished.");
      log("Skipped publishing at your request.");
    }
    setPhase(4);
    emit();
    timers.push(
      setTimeout(() => {
        complete();
      }, PHASE_MS[4])
    );
  }

  function complete() {
    setPhase(5);
    state.status = "done";
    state.progress = 100;
    state.doing = "Preview complete";
    state.why = "Nothing was executed. This was a simulation of the activity flow.";
    state.steps = state.steps.map((s) => ({ ...s, state: "done" }));
    for (const r of open()) {
      r.state = "skipped";
      state.outstanding.push(`Unanswered: ${r.text}`);
    }
    log("Task complete (simulated).");
    emit();
  }

  function start(task) {
    clear();
    state = {
      task: { id: task.id, text: task.text },
      status: "working", // working | waiting | done | stopped
      phase: 0,
      progress: 0,
      doing: "",
      why: "",
      steps: [],
      requests: [],
      log: [],
      outstanding: [],
    };
    log("Assignment received.");
    setPhase(0);
    emit();
    schedule(0);
  }

  // Answer an information request.
  function answer(id, text) {
    const r = state && state.requests.find((x) => x.id === id && x.state === "open" && x.kind === "info");
    if (!r) return false;
    r.state = "answered";
    r.answer = text;
    log(`You answered: ${r.text}`);
    emit();
    return true;
  }

  // Approve or decline a consequential action.
  function decide(id, approved) {
    const r = state && state.requests.find((x) => x.id === id && x.state === "open" && x.kind === "approval");
    if (!r) return false;
    r.state = "answered";
    r.answer = approved ? "approved" : "declined";
    log(approved ? `You approved: ${r.text}` : `You declined: ${r.text}`);
    emit();
    return true;
  }

  // Free-form contribution from the user while the task continues.
  function note(text) {
    if (!state) return;
    state.notes = state.notes || [];
    state.notes.push({ time: Date.now(), text });
    log(`You added: ${text}`);
    emit();
  }

  function stop() {
    if (!state || state.status === "done") return;
    clear();
    state.status = "stopped";
    state.doing = "Stopped by you";
    state.why = "Nothing was running. This is a simulation.";
    log("Stopped by you.");
    emit();
  }

  return { start, answer, decide, note, stop, dispose: clear, snapshot: () => (state ? snapshot() : null) };
}
