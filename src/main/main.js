"use strict";

const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const { PythonBridge } = require("./python-bridge");
const { pythonCandidates } = require("./python-locator");
const { registerBackendIpc } = require("./backend-ipc");
const { createFileLogger } = require("./logger");
const engine = require("./ollama-engine");
const { warmupChat, warmupVision, activeChats, clearCaches } = require("./chat-direct");
// Start FIDEX's own Qwen the instant the app launches (before the window and Python), so it is loaded and waiting for the first input.
// Packaged: use the bundled Python 3.11 Embeddable (no system Python needed).
if (app.isPackaged && !process.env.FIDEX_PYTHON) process.env.FIDEX_PYTHON = path.join(process.resourcesPath, "python", "python.exe");
// First launch (packaged): seed userData/ollama-models from the bundled ollama-models-seed.
function seedPackagedModels() {
  try {
    const dest = path.join(app.getPath("userData"), "ollama-models");
    const seed = path.join(process.resourcesPath, "ollama-models-seed");
    if (!fs.existsSync(dest) && fs.existsSync(seed)) fs.cpSync(seed, dest, { recursive: true });
  } catch (e) { console.error("ollama-models seed copy failed:", e); }
  return path.join(app.getPath("userData"), "ollama-models");
}
const earlyModelsDir = () => process.env.FIDEX_MODELS_DIR || (app.isPackaged ? seedPackagedModels() : path.join(__dirname, "..", "..", "models"));
let earlyStart = null, brainT0 = 0, brainMs = null;
// If the model is not bundled (installer too large for NSIS), pull it once into the app's own engine. Offline users can extract the model pack instead.
function ensureModelPresent(lg) {
  // No `ollama pull` and no terminal: the engine itself imports the bundled seed / FIDEX-SI-Model-*.zip (ollama-engine.js).
  return engine.refreshModels().then((names) => { if (lg) lg.info(`installed models: ${names.join(", ") || "NONE"} (chat=${engine.CHAT_MODEL}, brain=${engine.MODEL})`); });
}
function startEngineEarly() {
  if (!earlyStart) earlyStart = (() => {
    let lg = null;
    try { lg = createFileLogger(path.join(process.env.FIDEX_LOG_DIR || (app.isPackaged ? path.join(app.getPath("userData"), "logs") : path.join(__dirname, "..", "..", "data", "logs")), "brain-start.log"), "brain"); } catch (_) { /* no log */ }
    const t = Date.now();
    brainT0 = t;
    return engine.ensure({ modelsDir: earlyModelsDir(), log: lg }).then((ok) => { if (lg) lg.info(`engine up=${ok} after ${Date.now() - t} ms`); return ok ? ensureModelPresent(lg).then(() => warmupChat({ engine, logger: lg })).then((w) => { if (w) { brainMs = Date.now() - t; } /* vision loads only when an image is first used, so it never competes with the chat model */ if (lg) lg.info(`brain ready=${w} after ${Date.now() - t} ms`); return w; }) : false; }).then((r) => { if (!r) earlyStart = null; return r; }, (e) => { earlyStart = null; return false; });
  })();
  return earlyStart;
}
const { registerChatIpc } = require("./chat-direct");

// Only one FIDEX AI instance at a time.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// The interface is dark, so keep native parts (dialogs, scrollbars) dark as well.
nativeTheme.themeSource = "dark";

// Makes Windows group the taskbar button and show the FIDEX AI icon (not Electron's).
app.setAppUserModelId("com.fidelis.fidexai");

// The Windows application icon: white kite on black. See assets/icons/.
const ICON_DIR = path.join(__dirname, "..", "..", "assets", "icons");
const iconPath = path.join(ICON_DIR, process.platform === "win32" ? "icon.ico" : "icon.png");
const windowIcon = fs.existsSync(iconPath) ? iconPath : undefined;

const FULL_MIN = { width: 480, height: 420 };

let mainWindow = null;

const currentTheme = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: FULL_MIN.width,
    minHeight: FULL_MIN.height,
    show: false,
    title: "FIDEX SI",
    icon: windowIcon,
    frame: false, // custom title bar drawn by the interface
    backgroundColor: "#000000", // the welcome screen is pure black
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("maximize", () => sendToWindow("window:state", { maximized: true }));
  mainWindow.on("unmaximize", () => sendToWindow("window:state", { maximized: false }));
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

// Tell the window whenever Windows switches between light and dark.
nativeTheme.on("updated", () => sendToWindow("theme:changed", currentTheme()));

// ---------- Channels for the interface ----------
ipcMain.handle("app:get-info", () => ({
  name: "FIDEX SI",
  version: "1",
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  platform: process.platform,
}));

ipcMain.handle("theme:get", () => currentTheme());

// Window controls (the window has no native frame)
ipcMain.handle("window:minimize", () => mainWindow && mainWindow.minimize());
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow && mainWindow.close());

// ---------- Python backend (Step 4) and local storage (Step 5) ----------
// The Python process is owned by the main process only. The interface talks to it through two
// IPC channels (see backend-ipc.js and preload.js) and never sees the process itself.
// Nothing here waits for Python on the interface's behalf: every call is asynchronous.
let backend = null;
let backendLog = null;

function setupBackend() {
  const projectRoot = path.join(__dirname, "..", "..");
  const backendDir = app.isPackaged ? path.join(process.resourcesPath, "backend") : path.join(projectRoot, "backend");
  const logDir =
    process.env.FIDEX_LOG_DIR || (app.isPackaged ? path.join(app.getPath("userData"), "logs") : path.join(projectRoot, "data", "logs"));

  backendLog = createFileLogger(path.join(logDir, "python-bridge.log"), "backend");
  backend = new PythonBridge({
    backendDir,
    candidates: pythonCandidates({ backendDir }),
    logger: backendLog,
    // Step 5: Python keeps its SQLite database in <user-data>/db/fidex.sqlite. Only Python opens
    // it; the interface can reach it solely through backendRequest.
    env: { FIDEX_SKIP_AI_WARMUP: "1", FIDEX_OLLAMA_HOST: engine.HOST, ...(process.env.FIDEX_OLLAMA_MODEL ? { FIDEX_OLLAMA_MODEL: process.env.FIDEX_OLLAMA_MODEL } : {}), FIDEX_DATA_DIR: app.getPath("userData"), FIDEX_WHISPER_DIR: app.isPackaged ? path.join(process.resourcesPath, "assets", "whisper") : path.join(projectRoot, "assets", "whisper") },
  });

  const isTrustedSender = (event) =>
    mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === event.sender;

  registerBackendIpc({
    ipcMain,
    bridge: backend,
    isTrustedSender,
    sendStatus: (channel, status) => sendToWindow(channel, status),
    sendEvent: (channel, evt) => sendToWindow(channel, evt),
    logger: backendLog,
    onAppCommand: (type) => {
      if (type === "app.reset-chat-cache") { clearCaches(); return { cleared: true }; }
      // Safe restart: release the single-instance lock so the new copy can start, then quit normally
      // (before-quit stops Python and the engine first).
      app.releaseSingleInstanceLock();
      app.relaunch();
      setTimeout(() => app.quit(), 150);
      return { restarting: true };
    },
  });

  // Local model storage lives inside the FIDEX folder (override with FIDEX_MODELS_DIR). Normal Chat talks to Ollama directly.
  const modelsDir = process.env.FIDEX_MODELS_DIR || (app.isPackaged ? seedPackagedModels() : path.join(projectRoot, "models"));
  ipcMain.handle("chat:wake", (event) => (isTrustedSender(event) ? startEngineEarly().then((ok) => ({ ok: !!ok, sinceStart: Date.now() - brainT0, totalMs: brainMs, status: engine.status() })) : { ok: false })); // landing page: make sure the brain is awake
  ipcMain.handle("brain:status", (event) => (isTrustedSender(event) ? engine.status() : null));
  engine.onStatus((st) => sendToWindow("brain:status", st));
  const chatApi = registerChatIpc({ ipcMain, isTrustedSender, engine, modelsDir, logger: backendLog });
  startEngineEarly().then((ok) => { if (!ok) backendLog.warn("local Ollama engine/chat warm-up not available"); });

  // Start Python in the background. The window does not wait for it, and a failure here only
  // means backend requests report "unavailable"; the application itself keeps running.
  // Boot order: the brain (Ollama + chat model) powers up FIRST; the other organs (Python: ears, voice, memory) start the
  // moment the brain is ready, so they never compete with it for CPU/disk while it loads.
  startEngineEarly()
    .catch(() => false)
    .then(() => backend.start())
    .catch((err) => backendLog.error(`Python backend did not start: ${err.message}`));
}

// Shut Python down properly before the application quits (and never leave it running).
let quittingAfterBackendStop = false;
app.on("before-quit", (event) => {
  if (!backend || quittingAfterBackendStop) return;
  quittingAfterBackendStop = true;
  event.preventDefault();
  backend.stop().finally(() => {
    if (backendLog) backendLog.close();
    app.quit();
  });
});
app.on("will-quit", () => {
  engine.stop();
  if (backend) backend.killNow();
});

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on("second-instance", () => showMain());

if (gotSingleInstanceLock) {
  startEngineEarly(); // do not wait for the window
  // Keep the brain hot: a tiny 1-token request every 90 s (only when idle) stops the OS paging the model out, so answers stay as fast as the first ones.
  // (no idle pings: the model stays loaded with keep_alive -1, extra requests only compete with real answers)
}

app.whenReady().then(() => {
  // Allow the microphone (offline voice input) for our own window only; deny every other permission.
  const ses = require("electron").session.defaultSession;
  const allowed = (wc, perm) => (perm === "media" || perm === "audioCapture") && mainWindow && !mainWindow.isDestroyed() && (!wc || wc === mainWindow.webContents);
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(allowed(wc, perm)));
  ses.setPermissionCheckHandler((wc, perm) => allowed(wc, perm));
  if (process.platform === "darwin") { try { require("electron").systemPreferences.askForMediaAccess("microphone"); } catch (e) {} }
  if (gotSingleInstanceLock) setupBackend();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
