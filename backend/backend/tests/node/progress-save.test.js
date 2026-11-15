"use strict";
// Step 6: automatic save progress, from the panel state down to SQLite and back.
//  - progress-map / progress-saver / agent-sim / resume (renderer modules, real code, no Electron)
//  - the whole chain with real Python + SQLite, including close/reopen and a hard kill

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { loadApp } = require("./helpers/mock-electron");
const { sleep, waitFor } = require("./helpers/backend");

process.env.FIDEX_BACKEND_TEST = "1";
process.env.FIDEX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-logs-"));

const js = (f) => pathToFileURL(path.join(__dirname, "..", "..", "src", "renderer", "js", f)).href;
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const quiet = () => {
  const real = console.log;
  console.log = () => {};
  return () => (console.log = real);
};

async function load() {
  globalThis.window = globalThis.window || {}; // bridge.js reads window.fidex when imported
  const [map, saverMod, simMod] = await Promise.all([import(js("progress-map.js")), import(js("progress-saver.js")), import(js("agent-sim.js"))]);
  return { ...map, ...saverMod, ...simMod };
}

async function simStates(simMod, drive) {
  const states = [];
  const sim = simMod.createAgentSim({ onChange: (s) => states.push(s) });
  await drive(sim, states);
  sim.dispose();
  return states;
}

test("panel state -> save payload carries tasks, steps, requests, decisions, files and instructions", async () => {
  const { toSavePayload, createAgentSim, STEPS } = await load();
  let last;
  const sim = createAgentSim({ onChange: (s) => (last = s) });
  sim.start({ id: "t1", text: "Build a website for my shop" });
  sim.answer("r-folder", "D:\\Shop"); // not raised yet: ignored, must not crash
  sim.note("Use the blue theme");
  sim.dispose();
  const p = toSavePayload(last, STEPS.map((s) => s.id));
  assert.equal(p.id, "t1");
  assert.equal(p.status, "in_progress");
  assert.equal(p.steps.length, STEPS.length);
  assert.ok(p.context.some((c) => c.kind === "project" && c.content.includes("shop")));
  assert.ok(p.context.some((c) => c.kind === "instruction" && c.content === "Use the blue theme"));
  assert.equal(p.phase, "understand");
});

test("the saver sends in order, coalesces bursts, skips identical states and only reports confirmed saves", async () => {
  const { createProgressSaver, createAgentSim, STEPS } = await load();
  const sent = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const saver = createProgressSaver({
    stepIds: STEPS.map((s) => s.id),
    send: async (payload) => {
      sent.push(payload);
      if (sent.length === 1) await gate; // first save is slow
      return { ok: true, data: { saved_at: "2026-01-01T00:00:00.000+00:00" } };
    },
  });
  const sim = createAgentSim({ onChange: (s) => saver.queue(s) });
  sim.start({ id: "t1", text: "Task" });
  sim.note("one");
  sim.note("two");
  sim.note("three"); // burst while the first save is still in flight
  assert.equal(saver.status.lastSavedAt, null, "nothing is claimed as saved before the backend confirms");
  release();
  await saver.flush();
  sim.dispose();
  assert.equal(sent.length, 2, "first save + ONE coalesced newest state");
  assert.deepEqual(sent[1].context.filter((c) => c.kind === "instruction").map((c) => c.content), ["one", "two", "three"]);
  assert.equal(saver.status.lastSavedAt, "2026-01-01T00:00:00.000+00:00");
  const again = sent.length;
  saver.queue({ ...JSON.parse(JSON.stringify(sim.snapshot())) }); // identical state
  await saver.flush();
  assert.equal(sent.length, again);
});

test("a failed save is retried and is not reported as saved until it succeeds", async () => {
  const { createProgressSaver, createAgentSim, STEPS } = await load();
  let calls = 0;
  const saver = createProgressSaver({
    stepIds: STEPS.map((s) => s.id),
    retryMs: 10,
    log: { warn() {} },
    send: async () => (++calls < 3 ? { ok: false, error: { code: "BACKEND_EXITED", message: "down" } } : { ok: true, data: { saved_at: "T" } }),
  });
  const sim = createAgentSim({ onChange: () => {} });
  sim.start({ id: "t1", text: "Task" });
  saver.queue(sim.snapshot());
  sim.dispose();
  assert.equal(saver.status.lastSavedAt, null);
  assert.ok(await waitFor(() => saver.status.lastSavedAt === "T", 3000));
  assert.equal(calls, 3);
});

test("agent-sim resumes from saved progress: finished steps stay done, approvals come back open, nothing runs by itself", async () => {
  const { createAgentSim, fromRestored, STEPS } = await load();
  const entry = {
    task: { id: "t1", title: "Shop", instruction: "Build a website for my shop", progress: 58, updated_at: "2026-01-01T10:00:00.000+00:00" },
    steps: STEPS.map((s, i) => ({ key: s.id, label: s.label, state: i < 3 ? "done" : i === 3 ? "active" : "pending" })),
    requests: [
      { key: "r-folder", kind: "info", text: "Where is the project folder?", state: "answered", answer: "D:\\Shop" },
      { key: "a-publish", kind: "approval", text: "Publish the finished draft to the live site?", state: "open", answer: null },
    ],
    resume: { summary: "x", needs_reapproval: [{ text: "Publish the finished draft to the live site?" }], stopped_at: { label: "Carry out approved tasks" } },
  };
  let last;
  const sim = createAgentSim({ onChange: (s) => (last = s) });
  sim.resume(fromRestored(entry));
  assert.equal(last.phase, 3);
  assert.deepEqual(last.steps.map((s) => s.state), ["done", "done", "done", "active", "pending", "pending"]);
  assert.equal(last.requests.find((r) => r.id === "r-folder").answer, "D:\\Shop");
  assert.equal(last.requests.find((r) => r.id === "a-publish").state, "open");
  assert.ok(last.log.some((l) => /not saved/.test(l.text)), "the log says work after the last save was not saved");
  await sleep(1600); // the approval blocks execution: the task must not finish on its own
  assert.notEqual(last.status, "done");
  assert.ok(last.progress >= 58);
  sim.decide("a-publish", true);
  assert.ok(await waitFor(() => last.status === "done", 6000));
  sim.dispose();
});

test("on restart saved tasks are marked 'interrupted' and unsaved ones are NOT claimed as recovered", async () => {
  const { markUnfinished } = await import(js("resume.js"));
  const entry = (id) => ({ task: { id, title: id, instruction: "Saved " + id, progress: 40, created_at: "2026-01-01T00:00:00Z" }, resume: { stopped_at: { label: "Plan the work" } } });
  const commands = [
    { id: "a", text: "A", status: "working" },
    { id: "b", text: "B", status: "waiting" },
    { id: "c", text: "C", status: "done" },
  ];
  const found = await markUnfinished(commands, async () => ({ ok: true, data: { tasks: [entry("a"), entry("orphan")] } }));
  assert.deepEqual(commands.map((c) => [c.id, c.status]), [["orphan", "interrupted"], ["a", "interrupted"], ["b", "unsaved"], ["c", "done"]]);
  assert.equal(found.restored, 2);
  assert.equal(found.unsaved, 1);
  const untouched = [{ id: "z", text: "Z", status: "working" }];
  assert.equal(await markUnfinished(untouched, async () => ({ ok: false, error: { code: "BACKEND_EXITED" } })), null);
  assert.equal(untouched[0].status, "working", "backend unreachable: nothing is changed or claimed");
});

// ---------- the whole chain: panel -> preload -> main -> Python -> SQLite ----------
async function session(userData, fn) {
  const restore = quiet();
  const ctx = await loadApp({ userData });
  try {
    assert.ok(await waitFor(async () => (await ctx.api.getBackendStatus()).state === "ready", 10000), "backend ready");
    return await fn(ctx);
  } finally {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    ctx.app.emit("before-quit", event);
    await sleep(400);
    ctx.app.emit("will-quit", {});
    ctx.dispose();
    restore();
  }
}
const tempData = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-save-data-"));
  t.after(() => rm(dir));
  return dir;
};

test("a task saved by the panel is restored after closing and reopening, and continuing never auto-executes", async (t) => {
  const { createProgressSaver, createAgentSim, fromRestored, STEPS } = await load();
  const userData = tempData(t);
  await session(userData, async ({ api }) => {
    globalThis.window.fidex = { backendRequest: api.backendRequest };
    const saver = createProgressSaver({ stepIds: STEPS.map((s) => s.id), send: (p) => api.backendRequest("work.save", p) });
    const sim = createAgentSim({ onChange: (s) => saver.queue(s) });
    sim.start({ id: "taskone", text: "Plan the launch of my product" });
    assert.ok(await waitFor(() => sim.snapshot().phase >= 2, 8000));
    sim.note("Keep the budget under 500");
    await saver.flush();
    sim.dispose();
    assert.ok(saver.status.lastSavedAt, "backend confirmed the save");
  });
  await session(userData, async ({ api }) => {
    const res = await api.backendRequest("work.restore", {});
    assert.equal(res.ok, true);
    assert.equal(res.data.previous_session_ended_cleanly, true);
    assert.equal(res.data.tasks.length, 1);
    const entry = res.data.tasks[0];
    assert.equal(entry.task.id, "taskone");
    assert.ok(entry.task.progress >= 22);
    assert.ok(entry.context.some((c) => c.content === "Keep the budget under 500"));
    assert.ok(entry.resume.stopped_at, "knows where it stopped");
    const resumed = await api.backendRequest("work.resume", { id: "taskone" });
    assert.equal(resumed.data.auto_executed, false);
    const restored = fromRestored((await api.backendRequest("work.restore", {})).data.tasks[0]);
    assert.ok(restored.phase >= 2);
  });
});

test("after Python is killed mid-task, everything saved before the kill is still there", async (t) => {
  await session(tempData(t), async ({ api }) => {
    const save = (extra) => api.backendRequest("work.save", { id: "t1", title: "Crash task", status: "in_progress", ...extra });
    assert.equal((await save({ progress: 40, steps: [{ key: "plan", label: "Plan", state: "active" }] })).ok, true);
    process.kill((await api.getBackendStatus()).pid, "SIGKILL");
    assert.ok(await waitFor(async () => (await api.getBackendStatus()).state === "crashed"));
    const res = await api.backendRequest("work.restore", {}); // restarts Python
    assert.equal(res.ok, true);
    assert.equal(res.data.previous_session_ended_cleanly, false);
    assert.equal(res.data.tasks[0].task.progress, 40);
    assert.match(res.data.tasks[0].resume.summary, /closed unexpectedly/);
  });
});
