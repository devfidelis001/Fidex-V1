"use strict";
// Real speed benchmark of the running FIDEX engine (default http://127.0.0.1:11435). Uses the app's own prompt builder and options.
// Run (optional diagnostic):  node tools\bench-brain.js
const http = require("http");
const { buildMessages } = require("../src/main/chat-direct");
const engine = require("../src/main/ollama-engine");
const OPT = { num_ctx: 4096, num_predict: -1, temperature: 0.5, top_k: 20, top_p: 0.85 };
function run(label, messages, extra = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let first = 0, n = 0, info = {}, buf = "";
    const body = JSON.stringify({ model: engine.CHAT_MODEL, messages: buildMessages({ messages, ...extra.build }), stream: true, think: false, keep_alive: -1, options: { ...OPT, ...engine.RUNNER, ...(extra.opt || {}) } });
    const req = http.request(engine.HOST + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); if (o.message && o.message.content) { if (!first) first = Date.now() - t0; n++; } if (o.done) info = o; } catch (_) {} } });
      res.on("end", () => { console.log(`${label.padEnd(18)} first token ${String(first).padStart(5)} ms | total ${String(Date.now() - t0).padStart(6)} ms | ${info.eval_count || n} tokens @ ${info.eval_duration ? (info.eval_count / (info.eval_duration / 1e9)).toFixed(1) : "?"} tok/s | load ${Math.round((info.load_duration || 0) / 1e6)} ms | prompt ${info.prompt_eval_count || "?"} tok ${Math.round((info.prompt_eval_duration || 0) / 1e6)} ms`); resolve(); });
    });
    req.on("error", (e) => { console.log(label, "ERROR", e.message); resolve(); });
    req.end(body);
  });
}
(async () => {
  console.log("model:", engine.CHAT_MODEL, "host:", engine.HOST);
  await run("warm-up", [{ role: "user", content: "Hi" }], { opt: { num_predict: 1 } });
  await run("short question", [{ role: "user", content: "What is the capital of France?" }]);
  await run("long question", [{ role: "user", content: "Explain in detail how a car engine works, with its main parts and the four strokes." }]);
  const h = [{ role: "user", content: "My name is Ada and I like chess." }, { role: "assistant", content: "Nice to meet you, Ada." }, { role: "user", content: "What game do I like?" }];
  await run("follow-up", h);
  await run("SpeedX (short)", [{ role: "user", content: "Why is the sky blue?" }], { build: { short: true }, opt: { num_predict: 120 } });
})();
