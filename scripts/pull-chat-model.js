// Downloads a model into FIDEX's own models folder.  Usage:  node scripts/pull-chat-model.js [tag]
// Default tag = the chat model (qwen3.5:2b). Example for the Q4 candidate:  node scripts/pull-chat-model.js qwen3.5:2b-q4_K_M
// Close the normal Ollama app first. FIDEX's engine is started if needed (models folder: ./models or FIDEX_MODELS_DIR).
const path = require("path");
const http = require("http");
const engine = require("../src/main/ollama-engine");
const modelsDir = process.env.FIDEX_MODELS_DIR || path.join(__dirname, "..", "models");
const tag = process.argv[2] || engine.CHAT_MODEL;
(async () => {
  if (!(await engine.ensure({ modelsDir, log: console }))) { console.error("Ollama engine did not start. Is Ollama installed?"); process.exit(1); }
  console.log("models folder:", modelsDir, "| pulling", tag);
  let last = "";
  await new Promise((resolve) => {
    const req = http.request(engine.HOST + "/api/pull", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { for (const l of c.split("\n")) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o.error) console.error(o.error); const s = o.total ? `${o.status} ${Math.round((o.completed || 0) / o.total * 100)}%` : o.status; if (s !== last) { process.stdout.write(s + "\n"); last = s; } } catch (_) {} } });
      res.on("end", resolve);
    });
    req.on("error", (e) => { console.error(e.message); resolve(); });
    req.end(JSON.stringify({ model: tag, stream: true }));
  });
  const tags = await new Promise((r) => http.get(engine.HOST + "/api/tags", (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => r(b)); }).on("error", () => r("{}")));
  const names = (JSON.parse(tags).models || []).map((m) => m.name);
  console.log("installed in FIDEX folder:", names.join(", ") || "(none)");
  console.log(names.some((n) => n === tag || n === tag + ":latest") ? "OK: " + tag + " available." : "MISSING: " + tag);
  engine.stop(); process.exit(0);
})();
