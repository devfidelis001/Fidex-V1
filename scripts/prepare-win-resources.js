"use strict";
// Downloads/assembles everything bundled into the installer (run on Windows by CI or `npm run prepare:win`).
const fs = require("fs"), path = require("path"), https = require("https"), { execFileSync } = require("child_process");
const root = path.join(__dirname, ".."), res = path.join(root, "build-res");
const sh = (c, a, o = {}) => execFileSync(c, a, { stdio: "inherit", ...o });
const ps = (cmd) => sh("powershell", ["-NoProfile", "-Command", cmd]);
const dl = (u, f) => ps(`$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing '${u}' -OutFile '${f}'`);
const unzip = (z, d) => ps(`Expand-Archive -LiteralPath '${z}' -DestinationPath '${d}' -Force`);
for (const d of ["python", "ollama", "whisper", "tts"]) fs.mkdirSync(path.join(res, d), { recursive: true });

// Python embeddable + pip packages
const py = path.join(res, "python", "python.exe");
if (!fs.existsSync(py)) {
  dl("https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip", path.join(res, "py.zip"));
  unzip(path.join(res, "py.zip"), path.join(res, "python"));
  fs.writeFileSync(path.join(res, "python", "python311._pth"), ["python311.zip", ".", "Lib\\site-packages", "..\\..\\backend", "..\\backend", "import site"].join("\r\n"));
  dl("https://bootstrap.pypa.io/get-pip.py", path.join(res, "get-pip.py"));
  sh(py, [path.join(res, "get-pip.py"), "--no-warn-script-location"]);
  sh(py, ["-m", "pip", "install", "--no-warn-script-location", "setuptools", "wheel"]);
  sh(py, ["-m", "pip", "install", "--no-warn-script-location", "--prefer-binary", "--no-build-isolation", "-r", path.join(root, "backend", "requirements.txt")]);
}
sh(py, ["-c", "import pyautogui,PIL,numpy,cv2,dxcam,comtypes,uiautomation,sqlite3,piper;print('PY DEPS OK')"]);

// Ollama (MIT) + Qwen3.5 4B model (Apache-2.0)
const oll = path.join(res, "ollama", "ollama.exe");
if (!fs.existsSync(oll)) {
  dl("https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip", path.join(res, "ollama.zip"));
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
  dl("https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip", path.join(res, "w.zip"));
  unzip(path.join(res, "w.zip"), path.join(res, "w")); 
  ps(`Get-ChildItem '${path.join(res, "w")}' -Recurse -File | Copy-Item -Destination '${wdir}' -Force`);
  dl("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin", path.join(wdir, "model.bin"));
}
const T = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx";
if (!fs.existsSync(path.join(res, "tts", "en_US-lessac-medium.onnx"))) { dl(T, path.join(res, "tts", "en_US-lessac-medium.onnx")); dl(T + ".json", path.join(res, "tts", "en_US-lessac-medium.onnx.json")); }

// Model is ~3 GB: over NSIS's 2 GB cap, so ship it as a model pack release asset the app auto-imports.
const dist = path.join(root, "dist"); fs.mkdirSync(dist, { recursive: true });
sh("tar", ["-a", "-c", "-f", path.join(dist, "FIDEX-SI-Model-qwen3.5-4b.zip"), "-C", models, "manifests", "blobs"]);
fs.rmSync(models, { recursive: true, force: true }); // keep model out of installer
console.log("prepare done");
