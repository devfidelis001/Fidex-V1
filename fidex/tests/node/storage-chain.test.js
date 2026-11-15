"use strict";
// Step 5 through the WHOLE chain: renderer API -> preload -> IPC -> main.js -> Python -> SQLite,
// and back. Electron itself is mocked (helpers/mock-electron.js); Python and SQLite are real.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadApp } = require("./helpers/mock-electron");
const { sleep, waitFor } = require("./helpers/backend");

process.env.FIDEX_BACKEND_TEST = "1";
process.env.FIDEX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-logs-"));

const quiet = () => {
  const real = console.log;
  console.log = () => {};
  return () => (console.log = real);
};
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/** Open the app, run fn, then quit it the way a user would (Python is stopped, DB closed). */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-chain-data-"));
  t.after(() => rm(dir));
  return dir;
};

test("the database is created in the Electron user-data folder when the app starts", async (t) => {
  const userData = tempData(t);
  await session(userData, async () => {
    assert.ok(fs.existsSync(path.join(userData, "db", "fidex.sqlite")), "db/fidex.sqlite exists in userData before any database request");
  });
});

test("the renderer API reaches SQLite: create, read, update, delete", async (t) => {
  await session(tempData(t), async ({ api }) => {
    const conv = await api.backendRequest("conversation.create", { title: "From the interface" });
    assert.equal(conv.ok, true);
    assert.equal(conv.type, "conversation.create");
    const msg = await api.backendRequest("message.create", { conversation_id: conv.data.id, role: "user", content: "Hello ✓" });
    assert.equal(msg.ok, true);
    assert.equal((await api.backendRequest("message.list", { conversation_id: conv.data.id })).data.items[0].content, "Hello ✓");
    const task = await api.backendRequest("task.create", { title: "Do it", conversation_id: conv.data.id });
    assert.equal((await api.backendRequest("task.update", { id: task.data.id, status: "completed" })).data.status, "completed");
    assert.equal((await api.backendRequest("message.delete", { id: msg.data.id })).data.deleted, true);
    assert.equal((await api.backendRequest("conversation.delete", { id: conv.data.id })).data.deleted, true);
    assert.equal((await api.backendRequest("conversation.get", { id: conv.data.id })).error.code, "NOT_FOUND");
    assert.equal((await api.backendRequest("db.status")).data.counts.conversations, 0);
  });
});

test("data persists after closing and reopening FIDEX AI", async (t) => {
  const userData = tempData(t);
  let ids;
  await session(userData, async ({ api }) => {
    const conv = (await api.backendRequest("conversation.create", { title: "Keep me" })).data;
    const m1 = (await api.backendRequest("message.create", { conversation_id: conv.id, role: "user", content: "one ✓" })).data;
    const m2 = (await api.backendRequest("message.create", { conversation_id: conv.id, role: "assistant", content: "two" })).data;
    const task = (await api.backendRequest("task.create", { title: "Persist", conversation_id: conv.id, status: "in_progress" })).data;
    ids = { conv: conv.id, m1: m1.id, m2: m2.id, task: task.id };
  });
  assert.ok(fs.existsSync(path.join(userData, "db", "fidex.sqlite")));

  await session(userData, async ({ api }) => {
    assert.equal((await api.backendRequest("conversation.get", { id: ids.conv })).data.title, "Keep me");
    const msgs = (await api.backendRequest("message.list", { conversation_id: ids.conv })).data.items;
    assert.deepEqual(msgs.map((m) => m.id), [ids.m1, ids.m2]);
    assert.equal(msgs[0].content, "one ✓");
    assert.equal((await api.backendRequest("task.get", { id: ids.task })).data.status, "in_progress");
    assert.equal((await api.backendRequest("message.create", { conversation_id: ids.conv, role: "user", content: "three" })).data.seq, 3);
  });
});

test("data survives Python being killed (crash) and the automatic restart", async (t) => {
  await session(tempData(t), async ({ api }) => {
    const conv = (await api.backendRequest("conversation.create", { title: "Crash test" })).data;
    process.kill((await api.getBackendStatus()).pid, "SIGKILL");
    assert.ok(await waitFor(async () => (await api.getBackendStatus()).state === "crashed"));
    const again = await api.backendRequest("conversation.get", { id: conv.id }); // restarts Python
    assert.equal(again.ok, true);
    assert.equal(again.data.title, "Crash test");
  });
});

test("invalid database requests through the whole chain get safe errors", async (t) => {
  await session(tempData(t), async ({ api }) => {
    for (const [type, payload, code] of [
      ["conversation.create", { title: "" }, "INVALID_PAYLOAD"],
      ["conversation.create", { bogus: 1 }, "INVALID_PAYLOAD"],
      ["conversation.get", {}, "INVALID_PAYLOAD"],
      ["conversation.get", { id: "'; DROP TABLE conversations;--" }, "INVALID_PAYLOAD"],
      ["message.create", { conversation_id: "nope", role: "user", content: "x" }, "NOT_FOUND"],
      ["task.create", { title: "t", status: "someday" }, "INVALID_PAYLOAD"],
      ["task.nope", {}, "UNKNOWN_TYPE"],
    ]) {
      const res = await api.backendRequest(type, payload);
      assert.equal(res.ok, false, type);
      assert.equal(res.error.code, code, type);
      assert.doesNotMatch(res.error.message, /SELECT|INSERT|sqlite|Traceback/i);
    }
    assert.equal((await api.backendRequest("db.status")).ok, true, "the database is intact afterwards");
  });
});

test("the interface can only reach the database through backendRequest: no new functions, no paths", async (t) => {
  const userData = tempData(t);
  await session(userData, async ({ api }) => {
    assert.deepEqual(Object.keys(api).filter((k) => typeof api[k] !== "function"), []);
    assert.equal(Object.keys(api).filter((k) => /db|sql|database|storage/i.test(k)).length, 0, "no database function was added to window.fidex");
    const status = await api.backendRequest("db.status");
    assert.doesNotMatch(JSON.stringify(status), new RegExp(userData.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "the interface is never told where the file is");
  });
});

test("a database problem at startup does not stop FIDEX AI; requests report it", async (t) => {
  const blocked = path.join(tempData(t), "not-a-folder");
  fs.writeFileSync(blocked, "a file where the user-data folder should be");
  await session(blocked, async ({ api, mainWindow, app }) => {
    assert.equal((await api.backendRequest("hello", { message: "still works" })).ok, true);
    const res = await api.backendRequest("conversation.list", {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "DB_UNAVAILABLE");
    assert.equal(mainWindow.isDestroyed(), false);
    assert.equal(app.quitCalls, 0);
  });
});

test("the renderer's db-client module works against the real chain", async (t) => {
  // db-client.js is an ES module used by the page. Copy it (and bridge.js) next to a package.json that
  // marks them as modules, and give it the real preload API as window.fidex.
  const mod = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-esm-"));
  t.after(() => rm(mod));
  fs.writeFileSync(path.join(mod, "package.json"), '{"type":"module"}');
  for (const f of ["bridge.js", "db-client.js"]) fs.copyFileSync(path.join(__dirname, "..", "..", "src", "renderer", "js", f), path.join(mod, f));

  await session(tempData(t), async ({ api }) => {
    globalThis.window = { fidex: api };
    try {
      const { db } = await import(require("url").pathToFileURL(path.join(mod, "db-client.js")).href);
      const conv = await db.conversations.create({ title: "via client" });
      assert.equal(conv.ok, true);
      const msg = await db.messages.create({ conversation_id: conv.data.id, role: "user", content: "hi" });
      assert.equal(msg.data.seq, 1);
      assert.equal((await db.messages.list(conv.data.id, { limit: 10 })).data.total, 1);
      const task = await db.tasks.create({ title: "t" });
      assert.equal((await db.tasks.update(task.data.id, { status: "completed" })).data.status, "completed");
      assert.equal((await db.tasks.list({ status: "completed" })).data.total, 1);
      assert.equal((await db.conversations.update(conv.data.id, "renamed")).data.title, "renamed");
      assert.equal((await db.conversations.list()).data.items.length, 1);
      assert.equal((await db.conversations.get("missing")).error.code, "NOT_FOUND");
      assert.equal((await db.status()).data.counts.messages, 1);
      assert.equal((await db.tasks.delete(task.data.id)).data.deleted, true);
      assert.equal((await db.messages.delete(msg.data.id)).data.deleted, true);
      assert.equal((await db.conversations.delete(conv.data.id)).data.deleted, true);
    } finally {
      delete globalThis.window;
    }
  });
});
