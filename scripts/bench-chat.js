// FIDEX Chat benchmark (REAL model, FIDEX engine on 127.0.0.1:11435). Close FIDEX and the normal Ollama app first.
//   node scripts/bench-chat.js [--models qwen3.5:2b,qwen3.5:2b-q4_K_M] [--runs 3]
// Stage A: each model, short + long conversation (current prompt/history/default threads)
// Stage B: on the faster model: legacy history (12 msgs/3000 chars) vs current (6/1500) and current vs shorter system prompt
// Stage C: on the faster model: CPU thread counts (never all logical cores: Windows needs some)
// Every run uses a unique session tag in the system prompt, so Ollama cannot reuse cached prompt tokens: numbers are worst-case (cold prompt).
// Nothing in FIDEX is changed by this script. Results are printed and saved to bench-results.json.
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http");
const engine = require("../src/main/ollama-engine");
const { buildMessages } = require("../src/main/chat-direct");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const models = arg("models", "qwen3.5:2b,qwen3.5:2b-q4_K_M").split(",");
const RUNS = Number(arg("runs", 3));
const modelsDir = process.env.FIDEX_MODELS_DIR || path.join(__dirname, "..", "models");
const BASE = { num_ctx: 4096, num_predict: -1, temperature: 0.5, top_k: 20, top_p: 0.85, repeat_penalty: 1.05 };
const SHORT_PROMPT = "You are FIDEX AI, a personal assistant on the user's Windows PC. Reply in the user's language, directly, in at most 2 short sentences unless asked for detail. No preamble, markdown, tips or closing questions. If unsure, say so.";
const Q = "Explain JavaScript addEventListener";
const long = []; // 24 earlier messages (12 short exchanges) + the new question
const topics = ["CSS flexbox centering", "git rebase vs merge", "what a Python decorator is", "how DNS works", "Electron IPC basics", "SQL joins", "what a closure is", "HTTP caching", "React state", "Docker volumes", "regex lookahead", "async await"];
topics.forEach((t) => { long.push({ role: "user", content: `Quick question about ${t}: can you tell me how it works and when I would use it in a real project?` }); long.push({ role: "assistant", content: `${t} is a common tool. It works by following a few simple rules, and you use it when you need a predictable result without extra code or setup steps.` }); });
const shortConv = [{ role: "user", content: Q }];
const longConv = [...long, { role: "user", content: Q }];

function legacyMessages(msgs, system) { // the ORIGINAL history rule: last 12 messages, 3000 chars, whole messages
  const kept = []; let used = 0;
  for (const m of msgs.slice(-12).reverse()) { if (kept.length && used + m.content.length > 3000) break; kept.push(m); used += m.content.length; }
  kept.reverse(); while (kept.length && kept[0].role !== "user") kept.shift();
  return [{ role: "system", content: system }, ...kept];
}
const currentSystem = () => buildMessages({ messages: shortConv })[0].content;
const withTag = (msgs) => { const m = msgs.map((x) => ({ ...x })); m[0].content += `\nSession ${Math.random().toString(36).slice(2)}`; return m; };

function once(model, messages, options) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let first = null, buf = "", fin = null, text = "";
    const req = http.request(engine.HOST + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { const o = JSON.parse(l); if (o.error) { fin = { error: o.error }; } const t = o.message && o.message.content; if (t) { if (first === null) first = Date.now() - t0; text += t; } if (o.done) fin = o; } catch (_) {} } });
      res.on("end", () => resolve({ first, total: Date.now() - t0, fin, text }));
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.end(JSON.stringify({ model, messages, stream: true, think: false, keep_alive: "60m", options }));
  });
}
const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const results = [];
async function measure(label, model, build, options) {
  await once(model, withTag(build()), options); // discarded: (re)loads the model for these exact options
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await once(model, withTag(build()), options));
  const ok = runs.filter((r) => r.fin && !r.fin.error);
  if (!ok.length) { console.log(`${label}: FAILED ${(runs[0].error || (runs[0].fin && runs[0].fin.error)) || ""}`); return null; }
  const row = { label, model, options_extra: { num_thread: options.num_thread }, first_token_ms: med(ok.map((r) => r.first)), total_ms: med(ok.map((r) => r.total)), load_ms: med(ok.map((r) => (r.fin.load_duration || 0) / 1e6)), prompt_tokens: med(ok.map((r) => r.fin.prompt_eval_count)), prompt_eval_ms: med(ok.map((r) => (r.fin.prompt_eval_duration || 0) / 1e6)), gen_tok_s: med(ok.map((r) => r.fin.eval_count / ((r.fin.eval_duration || 1) / 1e9))), answer_chars: med(ok.map((r) => r.text.length)) };
  for (const k of ["first_token_ms", "total_ms", "load_ms", "prompt_eval_ms", "gen_tok_s"]) if (row[k] !== null) row[k] = Math.round(row[k] * 10) / 10;
  results.push(row);
  console.log(`${label.padEnd(46)} first ${String(row.first_token_ms).padStart(6)} ms | total ${String(row.total_ms).padStart(6)} ms | load ${String(row.load_ms).padStart(5)} ms | prompt ${row.prompt_tokens} tok ${String(row.prompt_eval_ms).padStart(6)} ms | gen ${row.gen_tok_s} tok/s`);
  return row;
}
(async () => {
  if (!(await engine.ensure({ modelsDir, log: console }))) { console.error("Ollama engine did not start."); process.exit(1); }
  const have = JSON.parse(await new Promise((r) => http.get(engine.HOST + "/api/tags", (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => r(b)); }).on("error", () => r("{}")))).models || [];
  const names = have.map((m) => m.name);
  const usable = models.filter((m) => names.some((n) => n === m || n === m + ":latest"));
  models.filter((m) => !usable.includes(m)).forEach((m) => console.log(`SKIPPED ${m}: not installed (node scripts/pull-chat-model.js ${m})`));
  if (!usable.length) process.exit(1);
  console.log(`CPU: ${os.cpus()[0].model.trim()} | logical cores ${os.cpus().length} | runs per row ${RUNS} (median) | cold prompt each run\n`);
  console.log("== Stage A: models ==");
  const cur = (c) => () => buildMessages({ messages: c });
  const A = [];
  for (const m of usable) { A.push(await measure(`${m} | short conv`, m, cur(shortConv), BASE)); A.push(await measure(`${m} | long conv`, m, cur(longConv), BASE)); }
  const longRows = A.filter((r) => r && r.label.endsWith("long conv"));
  const best = longRows.sort((a, b) => a.total_ms - b.total_ms)[0];
  if (!best) process.exit(1);
  const M = best.model;
  console.log(`\nfaster model on the long conversation: ${M}\n\n== Stage B: prompt + history (${M}) ==`);
  await measure("ORIGINAL: legacy history (12 msgs/3000) long", M, () => legacyMessages(longConv, currentSystem()), BASE);
  await measure("current history (6 msgs/1500) long", M, cur(longConv), BASE);
  await measure("current history + SHORT system prompt long", M, () => { const m = buildMessages({ messages: longConv }); m[0].content = SHORT_PROMPT; return m; }, BASE);
  const n = os.cpus().length;
  const threads = [...new Set([Math.max(2, Math.floor(n / 2)), Math.max(2, n - 2)])];
  console.log(`\n== Stage C: CPU threads (${M}, default = Ollama's choice) ==`);
  for (const t of threads) await measure(`num_thread ${t} long`, M, cur(longConv), { ...BASE, num_thread: t });
  fs.writeFileSync(path.join(__dirname, "..", "bench-results.json"), JSON.stringify({ cpu: os.cpus()[0].model, logical: n, runs: RUNS, results }, null, 2));
  console.log("\nSaved bench-results.json. Send me the table above.");
  engine.stop(); process.exit(0);
})();
