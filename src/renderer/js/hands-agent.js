// Windows Hands client for Take Over. Qwen (via the backend) decides ONE supported action at a time; every action needs the
// user's approval in the panel (except move/scroll/wait), runs for real in the backend (PyAutoGUI) and the REAL result goes back
// to Qwen for the next decision. Nothing is simulated: if Hands is unavailable, available() is false and Take Over keeps chatting only.
import { bridge } from "./bridge.js";

export function createHandsAgent({ sim, say: sayOut }) {
  let failed = false; // true when the task did NOT succeed: the panel must never say Done then
  const say = (t) => { if (/^(NOT COMPLETED|Failed|Declined|Could not|Hands )/i.test(String(t))) failed = true; sayOut(t); };
  let runId = 0; // bumped by stop(): a running loop notices and quits
  let started = false;
  let waiting = null; // {id, resolve} while an approval is open
  let availability = null;

  const alive = (id) => id === runId;
  const note = () => {}; // progress chatter is off: only errors and real questions are spoken

  // Pause Actions: the NEXT action is held (one already running finishes). The brain keeps planning in the backend, so on Resume
  // the queued steps run in order from the paused point: nothing is skipped and nothing runs twice.
  let paused = false;
  let waiters = [];
  async function gate(me, action) {
    if (!paused) return;
    sim.setActivity(action ? `Paused. Next: ${action.describe}` : "Paused. Thinking continues.");
    while (paused && alive(me)) await new Promise((r) => waiters.push(r));
  }
  function setPaused(flag) {
    paused = Boolean(flag);
    bridge.backendRequest("hands.pause", { paused }).catch(() => {}); // the backend also holds every action at execute(), so no route can slip past a pause
    if (!paused) { const w = waiters; waiters = []; w.forEach((r) => r()); }
  }
  // The task's ONE start time (set by agent-core when the task began). New messages never create a second clock.
  const taskStart = () => (sim.snapshot() || {}).startedAt || Date.now();

  async function available() {
    if (availability !== true) { // only a positive answer is cached: a backend that was still starting must not disable Hands for good
      const res = await bridge.backendRequest("hands.status", {});
      availability = Boolean(res.ok && res.data && res.data.available);
    }
    return availability;
  }

  // Called with every panel state: resolves the open approval when the user clicked Approve/Decline.
  function onState(state) {
    if (!waiting || !state) return;
    const r = state.requests.find((x) => x.id === waiting.id);
    // Any closed state resolves the wait (it used to resolve only on state "answered", so a different closed state left run() hanging
    // and hands.execute was never called). Only an unmistakable "approved" counts as approval; everything else is a decline.
    if (r && r.state !== "open") {
      const w = waiting;
      waiting = null;
      console.log("[hands] approval closed:", JSON.stringify({ state: r.state, answer: r.answer }));
      const yes = (v) => v === true || (typeof v === "string" && /^(approved?|yes|allow(ed)?)$/i.test(v));
      w.resolve(yes(r.answer) || yes(r.state) || yes(r.decision));
    }
  }

  function askApproval(action) {
    return new Promise((resolve) => {
      const id = "hands-" + action.id;
      waiting = { id, resolve };
      sim.addRequest({ id, kind: "approval", text: `Allow FIDEX AI to ${action.describe}?`, detail: "This will really control your mouse or keyboard on this computer. Press Stop at any time, or move the mouse into a screen corner.", blocks: true });
    });
  }

  function askUser(text) { // "wait for me": nothing runs until the user presses Continue
    return new Promise((resolve) => {
      const id = "wait-" + Date.now().toString(36);
      waiting = { id, resolve };
      sim.addRequest({ id, kind: "info", text: text || "Waiting for you. Tell me when to continue.", detail: "I will not do anything else until you press Continue.", placeholder: "Press Continue when you are ready", blocks: true });
    });
  }

  const elapsed = (t0) => ((Date.now() - t0) / 1000).toFixed(1); // seconds since the instruction was sent
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fast path for "do A and then B": every part must be a clear command the rule parser understands (no model involved).
  // Anything else falls back to the normal flow below. Text in quotes is never split.
  const APP_SETTLE_MS = 1500; // a launched app needs a moment before it can receive typing
  function splitSteps(text) {
    const t = String(text).replace(/^\s*task\s*:\s*/i, "").trim();
    const quoted = []; // quoted text is never split: hide it, split the rest, put it back
    const masked = t.replace(/"[^"]*"|\u201c[^\u201d]*\u201d|(?<=^|\s)'[^']*'(?=\s|$|[,.!?])/g, (m) => { quoted.push(m); return `\u0000${quoted.length - 1}\u0000`; });
    return masked.split(/\s*,\s*(?:and\s+)?(?:then\s+)?|\s+(?:and\s+then|then|and|after\s+that|afterwards)\s+/i).map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => quoted[Number(i)]));
  }

  // Incremental Read-and-Execute: clear leading commands run the moment they are read; whatever is left goes to the brain, which
  // streams one action at a time and each action runs as soon as it arrives (the model keeps writing while the hand works).
  async function runChain(parts, me, t0, forceTask = false) {
    // 1. Read every part with the fast rule parser (no model): this takes milliseconds.
    const results = await Promise.all(parts.map((part) => bridge.backendRequest("action.decide", { instruction: part, rules_only: true }))); // all parts at once, not one round trip after another
    if (!alive(me)) return "stopped";
    const decided = parts.map((part, i) => {
      const r = results[i];
      const d = r.ok && r.data ? r.data : {};
      return { part, src: d.source, action: d.action, clear: d.source === "rules" && d.action && !d.action.requires_approval };
    });
    const k = decided.findIndex((x) => !x.clear); // first part that needs the brain
    if (k === 0 && decided.every((x) => x.src === "none")) return forceTask ? runIRE(parts.join(" and "), me, t0) : "chat"; // a labelled task goes to the brain; anything else is conversation
    const prefix = k === -1 ? decided : decided.slice(0, k);
    // 2. The brain starts reading the remaining parts NOW, in parallel with the hand doing the clear ones.
    let job = null;
    if (k !== -1) {
      job = await startIRE(parts.slice(k).join(" and "), me, prefix.map((x) => x.action.describe));
      if (!alive(me)) return "stopped";
      if (!job) return "failed";
    }
    // 3. The hand runs the clear actions immediately, one by one.
    const goal = parts.join(" and ");
    const done = [];
    recovered = false;
    for (const x of prefix) {
      const ok = await runStep(x.action, me, t0, goal, done);
      if (ok !== true) {
        if (job) bridge.backendRequest("hands.ire_cancel", { job });
        return ok === "stopped" ? "stopped" : "failed";
      }
      if (recovered) { // a rethink completed the rest of the goal
        if (job) bridge.backendRequest("hands.ire_cancel", { job });
        sim.setActivity("");
        note(`Finished in ${elapsed(t0)}s after rethinking (every step verified).`);
        return "done";
      }
    }
    if (job) return drainIRE(job, me, t0, prefix.length, goal, done);
    sim.setActivity("");
    note(`Finished in ${elapsed(t0)}s. All ${done.length} step${done.length === 1 ? "" : "s"} succeeded and were verified.`);
    return "done";
  }

  // The executor decides how long to wait, so neither the user nor the model has to write wait steps.
  const LAUNCH_MS = [[/\bcode\b|vscode|visual studio/i, 6000], [/chrome|msedge|edge|firefox|https?:/i, 3500], [/whatsapp|spotify|word|excel|powerpoint|teams/i, 4000]];
  const launchDelay = (t) => { for (const [rx, ms] of LAUNCH_MS) if (rx.test(t)) return ms; return 1500; };
  let runBox = false; // the Win+R box is open: the Enter that confirms it launches something
  let runText = "";
  let settleUntil = 0; // a launched app needs a moment before it can receive typing
  // Runs ONE registered action, waits for its real result and reports it. Returns true | false | "stopped".
  let failedId = "";
  let lastError = ""; // the real error of the last failed step (fed to the retry / rethink)
  async function execStep(action, me, t0) {
    lastError = "";
    await gate(me, action);
    if (!alive(me)) return "stopped";
    if (action.type === "wait_user") {
      sim.setActivity("Waiting for you...");
      await askUser(action.message);
      if (!alive(me)) return "stopped";
      bridge.backendRequest("hands.execute", { action_id: action.id }).catch(() => {});
      sim.setActivity("");
      return true;
    }
    if (action.requires_approval) {
      sim.setActivity(`Waiting for your approval to ${action.describe}`);
      await bridge.backendRequest("hands.focus_mark", {}); // remember the app in front: the backend returns to it after the Approve click
      const ok = await askApproval(action);
      if (!alive(me)) return "stopped";
      const decided = await bridge.backendRequest("hands.approve", { action_id: action.id, approved: ok });
      if (!decided.ok && ok) { lastError = decided.error.message; say(decided.error.message); return false; }
      if (!ok) { sim.setActivity(""); say(`Declined: ${action.describe}. Nothing was done.`); return "declined"; }
    }
    if (action.type !== "wait" && Date.now() < settleUntil) await sleep(settleUntil - Date.now());
    await gate(me, action);
    if (!alive(me)) return "stopped";
    sim.setActivity(`Doing: ${action.describe} (${elapsed(t0)}s)`);
    const res = await bridge.backendRequest("hands.execute", { action_id: action.id });
    if (!alive(me)) return "stopped";
    const out = res.ok ? res.data : { ok: false, error: res.error };
    if (!out.ok) {
      sim.setActivity("");
      lastError = out.error ? out.error.message : "Unknown error.";
      failedId = action.id; // the backend keeps a failed action so the same step can be retried
      if (out.error && out.error.code === "HANDS_STOPPED") return "stopped";
      say(`Failed: ${action.describe}. ${lastError}`);
      return false;
    }
    if (action.type === "open_app") settleUntil = Date.now() + launchDelay(action.name);
    else if (action.type === "hotkey") { // a dialog (Run box, Save As, Find...) needs a moment before it can receive typing
      runBox = action.keys.join("+") === "win+r";
      runText = "";
      settleUntil = Date.now() + (runBox ? 600 : 700);
    } else if (action.type === "type" && runBox) runText = action.text;
    else if (action.type === "press" && action.key === "enter" && runBox) { settleUntil = Date.now() + launchDelay(runText); runBox = false; runText = ""; }
    if (action.type !== "wait") note(`Done: ${action.describe}. ${out.detail || ""}`.trim());
    return true;
  }


  // EVERY step must succeed AND be verified (the backend confirms the real effect). A failed step is never skipped:
  // 1) retry the same step, 2) stop and rethink: the brain finds ANOTHER approach (up to RETHINKS times), 3) if nothing works the task
  // is reported as NOT completed. Returns true | "stopped" | "declined" | false.
  const RETRIES = 1;
  const RETHINKS = 1; // one fast rethink, no 1/3 rounds
  async function runStep(action, me, t0, goal, done) {
    let ok = await execStep(action, me, t0);
    let cur = action;
    const noRetry = action.type === "open_app" || action.type === "open_path"; // an app that did not appear: do not wait for the same thing again, go straight to another route
    for (let i = 0; ok === false && !noRetry && i < RETRIES && alive(me); i++) {
      note(`Retrying: ${cur.describe}`);
      const r = await bridge.backendRequest("hands.retry", { action_id: failedId });
      if (!alive(me)) return "stopped";
      if (!r.ok) break;
      cur = r.data;
      ok = await execStep(cur, me, t0);
    }
    let attempt = 0;
    while (ok === false && alive(me) && attempt < RETHINKS) {
      attempt += 1;
      sim.setActivity("Trying another way...");
      const job = await bridge.backendRequest("hands.recover_start", { goal: goal || cur.describe, failed: cur.describe, error: lastError, done, attempt, action_id: failedId });
      if (!alive(me)) return "stopped";
      if (!job.ok) { if (job.error && job.error.code === "HANDS_STOPPED") return "stopped"; lastError = job.error ? job.error.message : lastError; continue; }
      let rec = null; // the model may think for a while: poll, never wait in one long request
      while (alive(me)) {
        const r = await bridge.backendRequest("hands.recover_result", { job: job.data.job });
        if (!alive(me)) return "stopped";
        if (!r.ok) { rec = { ok: false, error: r.error }; break; }
        if (r.data.state === "running") { await sleep(80); continue; }
        rec = r.data.state === "error" ? { ok: false, error: r.data.error } : { ok: true, data: r.data };
        break;
      }
      if (!rec || !alive(me)) return "stopped";
      if (!rec.ok) { if (rec.error && rec.error.code === "HANDS_STOPPED") return "stopped"; lastError = rec.error ? rec.error.message : lastError; continue; }
      if (!(rec.data.steps || []).length) { lastError = rec.data.say || lastError; break; }
      ok = true;
      for (const step of rec.data.steps || []) {
        cur = step;
        const o = await execStep(step, me, t0);
        if (o === true) { done.push(step.describe); continue; }
        ok = o;
        break; // this recovery route failed too: rethink again from here
      }
      if (ok === true) recovered = true;
    }
    if (ok === true) done.push(action.describe);
    else if (ok === false) { sim.setActivity(""); say(`NOT COMPLETED. Step failed after retry and ${attempt} other approach${attempt === 1 ? "" : "es"}: ${cur.describe}. ${lastError} Nothing after it was run and the task is not finished.`); }
    return ok;
  }
  let recovered = false; // a rethink already ran the rest of the goal: the original plan must not run again

  // Starts incremental reading in the backend (also warms the model). Returns the job id, or null after telling the user why not.
  async function startIRE(instruction, me, done = []) {
    const started = await bridge.backendRequest("hands.ire_start", { instruction, done });
    if (!alive(me)) return null;
    if (!started.ok) {
      sim.setActivity("");
      if (!started.error || started.error.code !== "HANDS_STOPPED") say(started.error ? started.error.message : "Hands could not start.");
      return null;
    }
    return started.data.job;
  }

  // SEE AND CORRECT: after the steps ran, FIDEX looks at the live screen (Live Vision starts by itself) and, when the goal is not
  // visibly achieved, runs a few corrective steps (a shortcut, or a click where it sees the right place) and looks again.
  // If vision is unavailable the task simply finishes as before: this check never blocks or breaks a task.
  const SEE_ROUNDS = 6; // no slow screen re-check after a task: each step is already verified, so the task ends the moment the last step succeeds
  async function seeAndFix(me, t0, goal, done) {
    for (let round = 1; round <= SEE_ROUNDS && alive(me); round++) {
      sim.setActivity(`Looking at the screen to check the result... (${elapsed(t0)}s)`);
      const r = await bridge.backendRequest("hands.see_check", { goal, done });
      if (!alive(me)) return "stopped";
      if (!r.ok) { if (!r.error || r.error.code !== "HANDS_STOPPED") sayOut(`I could not check the screen (${r.error ? r.error.message : "unknown error"}), so the result is not confirmed.`); return "unchecked"; }
      if (r.data.done) return "ok"; // visible on screen: really done
      if (!(r.data.steps || []).length) { await sleep(1200); continue; } // not visible and no fix yet: give the app a moment and look again
      note(`Screen check ${round}/${SEE_ROUNDS}: not finished yet, fixing it now.`);
      for (const action of r.data.steps) {
        const ok = await runStep(action, me, t0, goal, done);
        if (ok === "stopped") return "stopped";
        if (ok !== true) break; // that fix failed: look at the screen again and try another way
      }
      await sleep(400); // let the screen settle before the next look
    }
    failed = true;
    say("NOT COMPLETED. I looked at the screen several times and the goal is not visible, so I did not mark it done.");
    return "unfixed";
  }

  // Executes the steps of a job as they arrive, in order, each after the previous real result.
  async function drainIRE(job, me, t0, doneCount = 0, goal = "", done = []) {
    recovered = false;
    let cursor = 0;
    let count = doneCount;
    let usedScreen = false; // a step that works on the screen (so the result can be checked by looking at it)
    sim.setActivity("Setting the steps...");
    while (alive(me)) {
      const r = await bridge.backendRequest("hands.ire_poll", { job, cursor });
      if (!alive(me)) return;
      if (!r.ok) {
        sim.setActivity("");
        if (!r.error || r.error.code !== "HANDS_STOPPED") say(r.error ? r.error.message : "Hands lost the job.");
        return;
      }
      const d = r.data;
      for (const action of d.steps) {
        const ok = await runStep(action, me, t0, goal, done);
        cursor += 1;
        if (ok !== true) { bridge.backendRequest("hands.ire_cancel", { job }); return; } // failed after retries and rethinks / declined / stopped: nothing after it runs
        if (recovered) { // the rethink ran the rest of the goal: drop the old plan so nothing runs twice
          bridge.backendRequest("hands.ire_cancel", { job });
          sim.setActivity("");
          note(`Finished in ${elapsed(t0)}s after rethinking (every step verified).`);
          return;
        }
        if (action.type !== "wait") count += 1;
        if (["open_app", "hotkey", "press", "type", "click", "open_path"].includes(action.type)) usedScreen = true;
      }
      if (d.error) { // the plan itself broke part-way: the task is NOT finished, say so
        sim.setActivity("");
        if (d.error.code !== "HANDS_STOPPED") say(`NOT COMPLETED. ${d.error.message} The steps after this point were never run.`);
        return;
      }
      if (d.state === "done") {
        sim.setActivity("");
        if (d.say) say(d.say);
        else if (count === doneCount) say("I could not turn that into steps. Say it again with the target (for example: click the Start button).");
        else if (usedScreen && SEE_ROUNDS > 0 && (await seeAndFix(me, t0, goal, done)) === "stopped") return;
        if (!d.say && count !== doneCount) note(`Finished in ${elapsed(t0)}s. All ${done.length || count - doneCount} step(s) succeeded and were verified.`);
        return;
      }
      if (!d.steps.length) sim.setActivity(`Reading the next step... (${elapsed(t0)}s)`); // the backend long-polls: no sleep needed
    }
  }

  async function runIRE(instruction, me, t0, done = []) {
    const jobP = startIRE(instruction, me, done); // the brain starts reading NOW
    if (!done.length && /\b(desktop|minimi[sz]e|clear the screen)\b/i.test(instruction) && !/^\s*(task\s*:\s*)?(what|which|describe|tell me|can you see|do you see|look at)\b/i.test(instruction)) {
      sim.setActivity("Going to the desktop...");
      await bridge.backendRequest("hands.show_desktop", {}); // a new task starts on a clear desktop
      if (!alive(me)) return;
    }
    const job = await jobP;
    if (job) return drainIRE(job, me, t0, done.length, instruction, []);
  }

  // The brain plans the whole task in ONE call (the backend then unloads the model from RAM); the hand runs the steps alone.
  // Planning runs in the background and is polled, so it never hits a request time limit; a live counter shows the seconds.
  async function runBrain(instruction, me, t0) {
    const started = await bridge.backendRequest("hands.plan_start", { instruction });
    if (!alive(me)) return;
    if (!started.ok) {
      sim.setActivity("");
      if (!started.error || started.error.code !== "HANDS_STOPPED") say(started.error ? started.error.message : "Hands could not start planning.");
      return;
    }
    let plan = null;
    let shown = -1;
    while (alive(me)) {
      const sec = Math.floor((Date.now() - t0) / 1000);
      if (sec !== shown) { shown = sec; sim.setActivity(`Planning... ${sec}s`); }
      const r = await bridge.backendRequest("hands.plan_result", { job: started.data.job });
      if (!alive(me)) return;
      if (!r.ok) {
        sim.setActivity("");
        if (!r.error || r.error.code !== "HANDS_STOPPED") say(r.error ? r.error.message : "Hands lost the planning job.");
        return;
      }
      if (r.data.state === "running") { await sleep(250); continue; }
      if (r.data.state === "error") {
        sim.setActivity("");
        if (r.data.error.code !== "HANDS_STOPPED") say(r.data.error.message);
        return;
      }
      plan = r.data;
      break;
    }
    if (!plan || !alive(me)) return;
    const steps = plan.steps || [];
    if (!steps.length) {
      sim.setActivity("");
      say(plan.say || "I cannot do that with the supported actions.");
      return;
    }
    const planned = elapsed(t0);
    for (const action of steps) {
      await gate(me, action);
      if (!alive(me)) return;
      sim.setActivity(`Doing: ${action.describe} (${elapsed(t0)}s)`);
      const r = await bridge.backendRequest("hands.execute", { action_id: action.id });
      if (!alive(me)) return;
      const out = r.ok ? r.data : { ok: false, error: r.error };
      if (!out.ok) {
        sim.setActivity("");
        say(`Failed: ${action.describe}. ${out.error ? out.error.message : "Unknown error."} (${elapsed(t0)}s)`);
        return;
      }
      if (action.type !== "wait") note(`Done: ${action.describe}. ${out.detail || ""}`.trim());
    }
    sim.setActivity("");
    note(`Finished in ${elapsed(t0)}s (planning ${planned}s, doing ${(elapsed(t0) - planned).toFixed(1)}s).`);
  }

  // BIG tasks (build a website, plan a company...) go to another AI chosen by the user: the backend writes one good prompt (no model call),
  // the hand opens that AI in the browser, pastes the prompt and sends it. The AI is asked once, then remembered ("always claude").
  const DG_KEY = "fidex.delegateAi";
  const getSaved = () => { try { return localStorage.getItem(DG_KEY) || ""; } catch { return ""; } };
  const setSaved = (v) => { bridge.backendRequest("brain.remember", { kind: "preferred_ai", key: "default", value: String(v) }).catch(() => {}); try { localStorage.setItem(DG_KEY, v); } catch { /* storage unavailable: just ask again next time */ } };
  let pendingBig = null; // a big task waiting for the user to name the AI
  async function delegateBig(instruction, me, t0) {
    let task = String(instruction);
    let ai = "";
    let remember = false;
    if (pendingBig) { // the user is answering "which AI?"
      const a = await bridge.backendRequest("delegate.check", { instruction: "use " + task.replace(/\b(always|remember|default|use|only|please|with)\b/gi, " ").replace(/\s+/g, " ").trim() }); // "always Claude" -> "use Claude"
      if (a.ok && a.data && a.data.ai) { ai = a.data.ai; task = pendingBig; remember = /\b(always|remember|default)\b/i.test(instruction); }
      pendingBig = null;
      if (!ai) return false; // a different message: handle it normally
    } else {
      const c = await bridge.backendRequest("delegate.check", { instruction: task });
      if (!c.ok || !c.data || !c.data.big) return false;
      ai = c.data.ai || getSaved();
      if (!ai) {
        pendingBig = task;
        const names = (c.data.ais || []).map((x) => x.label).join(", ");
        sim.addRequest({ id: "delegate-" + Date.now().toString(36), kind: "info", text: "This is a big task. Which AI should I hand it to?", detail: `Options: ${names}. Add "always" to remember it (example: always Claude).`, placeholder: "Claude, ChatGPT, Gemini...", blocks: true });
        return true;
      }
    }
    if (remember) setSaved(ai);
    const planned = await bridge.backendRequest("delegate.plan", { instruction: task, ai });
    if (!alive(me)) return true;
    if (!planned.ok) { say(planned.error ? planned.error.message : "Could not prepare the hand-off."); return true; }
    const { label, steps } = planned.data;
    say(`Big task: sending it to ${label} with a prepared prompt.`);
    const doneSteps = [];
    recovered = false;
    for (const action of steps) {
      const ok = await runStep(action, me, t0, `hand this task to ${label}: ${task}`.slice(0, 1500), doneSteps);
      if (ok !== true) return true; // runStep already reported NOT COMPLETED
      if (recovered) break;
    }
    sim.setActivity("");
    say(`Sent to ${label} in ${elapsed(t0)}s. It is working on your request in the browser.`);
    return true;
  }

  // Runs one instruction to the end: plan -> approve -> execute -> feed result -> plan ... until Qwen says it is done.
  // AUTOPILOT: sets today's goal, picks a task, does it with Take Over, records it, picks the next one... up to 9 hours, no questions.
  const AUTO_RX = /\b(start working on|keep working on|continue working on|carry on with|work on (?:our|the|my) project|autopilot|auto pilot|work (?:tirelessly|non[- ]?stop)|work for (?:up to )?\d+ hours)\b/i;
  let inAuto = false;
  async function runAutopilot(instruction, me) {
    const st = await bridge.backendRequest("autopilot.start", { instruction });
    if (!alive(me)) return;
    if (!st.ok || !st.data || !st.data.ok) { say((st.data && st.data.say) || "Autopilot could not start."); return; }
    say(`Autopilot is on. Goal for today: ${st.data.goal}. I will keep working, up to 9 hours, and continue tomorrow from where I stop.`);
    inAuto = true;
    let n = 0, fails = 0;
    try {
      while (alive(me)) {
        const nx = await bridge.backendRequest("autopilot.next", {});
        if (!alive(me)) return;
        if (!nx.ok) { say(nx.error ? nx.error.message : "Autopilot lost its plan."); return; }
        const d = nx.data;
        if (d.retry) { say(`Goal achieved. New goal: ${d.new_goal}`); continue; }
        if (!d.task) { failed = false; say(d.reason || "Autopilot finished."); return; }
        n += 1;
        sim.setActivity(`Autopilot task ${n}: ${d.task}`);
        await run("Task: " + d.task);
        const ok = !failed;
        await bridge.backendRequest("autopilot.report", { ok });
        fails = ok ? 0 : fails + 1;
        if (fails >= 5) { say("NOT COMPLETED. Autopilot paused after 5 failed tasks in a row. Tell me what to change."); return; }
        failed = false;
        await sleep(500);
      }
    } finally { inAuto = false; }
  }

  async function run(instruction) {
    const me = runId;
    failed = false;
    if (!inAuto && instruction != null && AUTO_RX.test(String(instruction))) return runAutopilot(String(instruction).replace(/^\s*task\s*:\s*/i, ""), me);
    const t0 = taskStart(); // the original start, so elapsed times never restart when a new message arrives
    if (!/^\s*task\s*:/i.test(String(instruction))) bridge.backendRequest("hands.warm", {}).catch(() => {}); // tasks do not warm first: a busy backend would delay the planner itself
    const startP = !started ? (started = true, bridge.backendRequest("hands.start", {})) : null; // all start-up checks run AT THE SAME TIME, not one after another
    if (instruction != null) {
      const isTask = /^\s*task\s*:/i.test(String(instruction)); // a labelled task is an ORDER: no statement-learning detour, no chat
      if (isTask && String(instruction).length <= 100) { if (startP) await startP; if (!alive(me)) return; return runIRE(instruction, me, t0); } // short task: plan NOW, no extra round trips
      const learnP = isTask ? null : bridge.backendRequest("brain.learn", { text: String(instruction) });
      const knownP = bridge.backendRequest("brain.resolve", { text: String(instruction) });
      const learned = learnP ? await learnP : null;
      if (learned && learned.ok && learned.data && learned.data.statement) {
        sim.setActivity("");
        say(`Saved: ${(learned.data.saved || []).join(", ") || "that"}. I will remember it.`);
        return "saved";
      }
      const known = await knownP;
      if (known.ok && known.data && known.data.replaced && known.data.replaced.length) instruction = known.data.text;
      if (startP) await startP;
      if (await delegateBig(instruction, me, t0)) return;
      if (!alive(me)) return;
      if (isTask) return runIRE(instruction, me, t0); // every task goes straight to the instant planner: it never falls back to chat, so it never says "I cannot"
      const parts = splitSteps(instruction);
      if (parts.length > 1) {
        const outcome = await runChain(parts, me, t0, /^\s*task\s*:/i.test(instruction));
        if (outcome === "chat") return "chat";
                return;
      }
    }
    if (instruction != null && /\b(create|make|new)\b.{0,40}\b(folder|file)\b/i.test(String(instruction))) return runIRE(instruction, me, t0); // folders/files go straight to the instant planner (never to chat)
    let next = instruction;
    let oneShot = false; // a clear single command (handled by rules, no "then/and") needs no extra model round after it runs
    while (alive(me)) {
      sim.setActivity("Working...");
      // A new instruction goes through the Action Decision Engine (same shape as hands.plan, plus needs_action/tool/params);
      // follow-up steps keep using hands.plan with the real results.
      const planned = next == null ? await bridge.backendRequest("hands.plan", {}) : await bridge.backendRequest("action.decide", { instruction: next, rules_only: true });
      next = null;
      if (!alive(me)) return;
      if (!planned.ok) {
        sim.setActivity("");
        if (!planned.error || planned.error.code !== "HANDS_STOPPED") say(planned.error ? planned.error.message : "Hands could not plan the next step.");
        return;
      }
      const plan = planned.data;
      if (plan.source === "unparsed") return runIRE(instruction, me, t0); // an action, but not a clear command: plan it once
      if (plan.source === "none") { sim.setActivity(""); return "chat"; } // the engine found no action needed: normal conversation
      const action = plan.action;
      if (plan.source === "rules" && instruction != null && !/\b(then|and|after that|afterwards|next)\b/i.test(String(instruction).replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, ""))) oneShot = true;
      // Only speak before acting when there is NO action; with an action, the user hears "Done" only after hands.execute really succeeded.
      if (plan.say && !action) say(plan.say);
      if (!action) {
        sim.setActivity("");
        if (plan.done) sim.complete(plan.say || "Finished");
        return;
      }
      recovered = false;
      const okStep = await runStep(action, me, t0, String(instruction || action.describe), []);
      if (okStep === "declined") {
        if (oneShot) { sim.setActivity(""); return; }
        next = null; // Qwen sees the declined result and decides what to do instead
        continue;
      }
      if (okStep !== true) return; // failed after retry and rethink (already reported as NOT COMPLETED) or stopped
      sim.setActivity("");
      if (oneShot || plan.last || recovered) return; // verified for real: back to the user without another planning round
    }
  }

  return {
    available,
    onState,
    run,
    setPaused,
    failed: () => failed,
    pending: () => Boolean(pendingBig), // a big task is waiting for the user to name the AI
    reset() { pendingBig = null; setPaused(false); },
    // Stop: ends the loop, rejects any open approval and tells the backend to halt planning and typing immediately.
    stop() {
      runId++;
      waiting = null;
      started = false;
      pendingBig = null;
      setPaused(false); // releases anything held at the pause gate (it then sees the run is no longer alive)
      return bridge.backendRequest("hands.stop", {});
    },
  };
}
