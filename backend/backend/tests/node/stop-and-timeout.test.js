"use strict";
// Electron bridge + Python backend + a fake Ollama: AI answers have no timer, and chat.cancel (Stop) cancels at once.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { makeBridge, sleep } = require("./helpers/backend");

function fakeOllama({ chunks, gapMs, silentMs = 0 }) {
  const state = { closedEarly: false, calls: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.on("close", () => { if (!res.writableEnded) state.closedEarly = true; });
      if (silentMs) await sleep(silentMs); // the model has accepted the request but says nothing yet
      if (res.destroyed) return;
      const list = state.calls++ === 0 ? chunks : ["ok"]; // only the first request is long
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (const text of list) {
        if (res.destroyed) return;
        res.write(JSON.stringify({ message: { content: text } }) + "\n");
        await sleep(gapMs);
      }
      if (!res.destroyed) res.end(JSON.stringify({ done: true, model: "qwen3.5:4b" }) + "\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

const ask = { messages: [{ role: "user", content: "write something long" }] };

test("a slow answer is never cut off by a timer (chat.stream has no timeout)", async (t) => {
  const { server, url } = await fakeOllama({ chunks: ["one ", "two ", "three"], gapMs: 400 });
  const bridge = makeBridge({ requestTimeoutMs: 300, longRequestTimeoutMs: 300, env: { FIDEX_BACKEND_TEST: "1", FIDEX_OLLAMA_HOST: url } });
  t.after(async () => { await bridge.stop(); server.close(); });
  const res = await bridge.request("chat.stream", { ...ask, stream_id: "slow1" }); // takes ~1.2 s, limits are 0.3 s
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.data.text, "one two three");
  assert.ok(!bridge.logs.some((l) => /timed out/.test(l)));
});

test("Stop cancels the running generation at once and the next message works", async (t) => {
  const chunks = Array.from({ length: 200 }, (_, i) => `w${i} `);
  const { server, state, url } = await fakeOllama({ chunks, gapMs: 100 }); // would run for 20 s
  const bridge = makeBridge({ env: { FIDEX_BACKEND_TEST: "1", FIDEX_OLLAMA_HOST: url } });
  t.after(async () => { await bridge.stop(); server.close(); });
  const tokens = [];
  bridge.on("backend-event", (e) => e.event === "chat.token" && e.data.stream_id === "stop1" && tokens.push(e.data.text));
  const running = bridge.request("chat.stream", { ...ask, stream_id: "stop1" });
  const t0 = Date.now();
  while (!tokens.length && Date.now() - t0 < 5000) await sleep(20);
  assert.ok(tokens.length > 0, "generation started");
  const stopAt = Date.now();
  const cancel = await bridge.request("chat.cancel", { stream_id: "stop1" });
  assert.equal(cancel.ok, true);
  const res = await running;
  assert.ok(Date.now() - stopAt < 1500, "cancelled quickly, not after the 20 s answer");
  assert.equal(res.ok, true);
  assert.equal(res.data.cancelled, true);
  await sleep(200);
  assert.equal(state.closedEarly, true, "the connection to the model was closed, so it stops generating");
  const next = await bridge.request("chat.stream", { messages: [{ role: "user", content: "next" }], stream_id: "stop2" });
  assert.equal(next.ok, true); // generation lock was released
});

test("Stop works while the model has not sent anything yet, and the backend is free right after", async (t) => {
  const { server, url } = await fakeOllama({ chunks: ["never seen"], gapMs: 10, silentMs: 15000 });
  const bridge = makeBridge({ env: { FIDEX_BACKEND_TEST: "1", FIDEX_OLLAMA_HOST: url } });
  t.after(async () => { await bridge.stop(); server.close(); });
  const running = bridge.request("chat.stream", { ...ask, stream_id: "quiet1" });
  await sleep(500); // request is out, the model is silent
  const stopAt = Date.now();
  await bridge.request("chat.cancel", { stream_id: "quiet1" });
  const res = await running;
  assert.ok(Date.now() - stopAt < 1500, "the generation thread stopped waiting at once");
  assert.equal(res.ok, true);
  assert.equal(res.data.cancelled, true);
  assert.equal(res.data.text, "");
});
