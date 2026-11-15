"use strict";
// Downloads/assembles everything bundled into the installer (run on Windows by CI or `npm run prepare:win`).
const fs = require("fs"), path = require("path"), https = require("https"), { execFileSync } = require("child_process");
const root = path.join(__dirname, ".."), res = path.join(root, "build-res");
const sh = (c, a, o = {}) => execFileSync(c, a, { stdio: "inherit", ...o });
const ps = (cmd) => sh("powershell", ["-NoProfile", "-Command", cmd]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function dl(u, f, tries = 5) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const h = { "User-Agent": "fidex-si-build" };
      if (process.env.GITHUB_TOKEN && /^https:\/\/(api\.)?github\.com\//.test(u)) h.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
      const r = await fetch(u, { redirect: "follow", headers: h });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1024) throw new Error("download too small (" + buf.length + " bytes)");
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf);
      console.log(`downloaded ${u} (${(buf.length / 1048576).toFixed(1)} MB)`); return;
    } catch (e) { last = e; console.warn(`download attempt ${i}/${tries} failed for ${u}: ${e.message}`); await sleep(2000 * i); }
  }
  throw new Error(`Download failed after ${tries} attempts: ${u} -> ${last && last.message}`);
}
async function getJson(u) {
  const h = { "User-Agent": "fidex-si-build", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  const r = await fetch(u, { headers: h }); if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`); return r.json();
}
// Finds the Windows x64 CPU whisper.cpp zip by scanning recent releases (asset names change between versions).
async function findWhisperZip() {
  const pinned = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.5/whisper-bin-x64.zip";
  try {
    const rels = await getJson("https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15");
    for (const re of [/^whisper-bin-x64\.zip$/i, /^whisper.*bin.*x64.*\.zip$/i]) {
      for (const rel of rels) {
        const a = (rel.assets || []).find((x) => re.test(x.name) && !/cublas|cuda|blas|vulkan|openblas/i.test(x.name));
        if (a) { console.log(`whisper.cpp asset: ${a.name} from ${rel.tag_name}`); return a.browser_download_url; }
      }
    }
    console.warn("no matching whisper asset in recent releases; assets seen: " + rels.slice(0, 3).map((r) => r.tag_name + ": " + (r.assets || []).map((x) => x.name).join(",")).join(" | "));
  } catch (e) { console.warn("release lookup failed: " + e.message); }
  console.warn("falling back to pinned " + pinned); return pinned;
}
const unzip = (z, d) => ps(`Expand-Archive -LiteralPath '${z}' -DestinationPath '${d}' -Force`);
(async () => {
for (const d of ["python", "ollama", "whisper", "tts"]) fs.mkdirSync(path.join(res, d), { recursive: true });

// Python embeddable + pip packages
const py = path.join(res, "python", "python.exe");
if (!fs.existsSync(py)) {
  await dl("https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip", path.join(res, "py.zip"));
  unzip(path.join(res, "py.zip"), path.join(res, "python"));
  fs.writeFileSync(path.join(res, "python", "python311._pth"), ["python311.zip", ".", "Lib\\site-packages", "..\\..\\backend", "..\\backend", "import site"].join("\r\n"));
  await dl("https://bootstrap.pypa.io/get-pip.py", path.join(res, "get-pip.py"));
  sh(py, [path.join(res, "get-pip.py"), "--no-warn-script-location"]);
  sh(py, ["-m", "pip", "install", "--no-warn-script-location", "setuptools", "wheel"]);
  sh(py, ["-m", "pip", "install", "--no-warn-script-location", "--prefer-binary", "--no-build-isolation", "-r", path.join(root, "backend", "requirements.txt")]);
}
sh(py, ["-c", "import pyautogui,PIL,numpy,cv2,dxcam,comtypes,uiautomation,sqlite3,piper;print('PY DEPS OK')"]);

// Ollama (MIT) + Qwen3.5 4B model (Apache-2.0)
const oll = path.join(res, "ollama", "ollama.exe");
if (!fs.existsSync(oll)) {
  await dl("https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip", path.join(res, "ollama.zip"));
  unzip(path.join(res, "ollama.zip"), path.join(res, "ollama"));
  for (const d of ["rocm", "vulkan", "cuda_v13", "cuda_v11"]) fs.rmSync(path.join(res, "ollama", "lib", "ollama", d), { recursive: true, force: true });
}
const models = path.join(res, "models");
if (!fs.existsSync(path.join(models, "manifests"))) {
  fs.mkdirSync(models, { recursive: true });
  const srv = require("child_process").spawn(oll, ["serve"], { env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11436", OLLAMA_MODELS: models }, stdio: "ignore" });
  try { sh("powershell", ["-NoProfile", "-Command", "Start-Sleep 6"]); sh(oll, ["pull", "qwen3.5:4b"], { env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11436", OLLAMA_MODELS: models } }); } finally { srv.kill(); }
}

// Whisper.cpp + model, Piper voice
const wdir = path.join(res, "whisper");
if (!fs.existsSync(path.join(wdir, "model.bin"))) {
  fs.rmSync(path.join(res, "w"), { recursive: true, force: true });
  await dl(await findWhisperZip(), path.join(res, "w.zip"));
  unzip(path.join(res, "w.zip"), path.join(res, "w"));
  ps(`Get-ChildItem '${path.join(res, "w")}' -Recurse -File | Copy-Item -Destination '${wdir}' -Force`);
  if (!fs.existsSync(path.join(wdir, "whisper-cli.exe"))) throw new Error("whisper-cli.exe not found after extraction; folder has: " + fs.readdirSync(wdir).join(", "));
  await dl("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin", path.join(wdir, "model.bin"));
}
const T = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx";
if (!fs.existsSync(path.join(res, "tts", "en_US-lessac-medium.onnx"))) { await dl(T, path.join(res, "tts", "en_US-lessac-medium.onnx")); await dl(T + ".json", path.join(res, "tts", "en_US-lessac-medium.onnx.json")); }

// Model is ~3 GB: over NSIS's 2 GB cap, so ship it as a model pack release asset the app auto-imports.
const dist = path.join(root, "dist"); fs.mkdirSync(dist, { recursive: true });
sh("tar", ["-a", "-c", "-f", path.join(dist, "FIDEX-SI-Model-qwen3.5-4b.zip"), "-C", models, "manifests", "blobs"]);
fs.rmSync(models, { recursive: true, force: true }); // keep model out of installer
console.log("prepare done");
})().catch((e) => { console.error("PREPARE FAILED: " + (e && e.stack || e)); process.exit(1); });
