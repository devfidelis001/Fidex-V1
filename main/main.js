"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, nativeTheme, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { PythonBridge } = require("./python-bridge");
const { pythonCandidates } = require("./python-locator");
const { registerBackendIpc } = require("./backend-ipc");
const { createFileLogger } = require("./logger");

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
const OVERLAY_MARGIN = 20;
const OVERLAY_START = { width: 400, height: 190 };

let mainWindow = null;
let overlayWindow = null;
let tray = null;

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
    title: "FIDEX AI",
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
    destroyOverlay();
    app.quit();
  });
}

// Tell the window whenever Windows switches between light and dark.
nativeTheme.on("updated", () => sendToWindow("theme:changed", currentTheme()));

// ---------- Channels for the interface. Future features add their own here. ----------
ipcMain.handle("app:get-info", () => ({
  name: "FIDEX AI",
  version: app.getVersion(),
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
    env: { FIDEX_DATA_DIR: app.getPath("userData"), FIDEX_WHISPER_DIR: app.isPackaged ? path.join(process.resourcesPath, "assets", "whisper") : path.join(projectRoot, "assets", "whisper") },
  });

  const isTrustedSender = (event) =>
    [mainWindow, overlayWindow].some((w) => w && !w.isDestroyed() && w.webContents === event.sender);

  registerBackendIpc({
    ipcMain,
    bridge: backend,
    isTrustedSender,
    sendStatus: (channel, status) => sendToWindow(channel, status),
    sendEvent: (channel, evt) => {
      for (const w of [mainWindow, overlayWindow]) if (w && !w.isDestroyed()) w.webContents.send(channel, evt);
    },
    logger: backendLog,
  });

  // Start Python in the background. The window does not wait for it, and a failure here only
  // means backend requests report "unavailable"; the application itself keeps running.
  backend.start().catch((err) => backendLog.error(`Python backend did not start: ${err.message}`));
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
  if (backend) backend.killNow();
});

// ---------- Take Over window ----------
// A separate, transparent, frameless window that holds two independent elements: the logo circle
// and the activity panel. The full interface hides while it is open. It is resized by its own
// content (overlay:resize), keeping the circle in place.

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function destroyOverlay() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  overlayClosing = true;
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
}

function createTray() {
  if (tray) return;
  const pngPath = path.join(ICON_DIR, "icon.png");
  if (!fs.existsSync(pngPath)) return;
  tray = new Tray(nativeImage.createFromPath(pngPath).resize({ width: 16, height: 16 }));
  tray.setToolTip("FIDEX AI");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open FIDEX AI", click: () => showMain() },
      { label: "Quit", click: () => app.quit() },
    ])
  );
  tray.on("click", () => showMain());
}

let overlayOnTop = true;
let overlayClosing = false;
function createOverlayWindow(alwaysOnTop) {
  overlayClosing = false;
  const { workArea } = screen.getDisplayMatching(mainWindow ? mainWindow.getBounds() : screen.getPrimaryDisplay().bounds);
  overlayWindow = new BrowserWindow({
    width: OVERLAY_START.width,
    height: OVERLAY_START.height,
    x: workArea.x + workArea.width - OVERLAY_START.width - OVERLAY_MARGIN,
    y: workArea.y + workArea.height - OVERLAY_START.height - OVERLAY_MARGIN,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false, // nothing (Win+M, the taskbar, an opening app) can minimise the Take Over square
    fullscreenable: false,
    alwaysOnTop,
    title: "FIDEX AI - Take Over",
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayOnTop = alwaysOnTop;
  if (alwaysOnTop) overlayWindow.setAlwaysOnTop(true, "screen-saver"); // the highest level: Chrome and other apps cannot cover it
  overlayWindow.loadFile(path.join(__dirname, "..", "renderer", "overlay.html"));
  // The Take Over square and circle must ALWAYS stay on screen, whatever app opens. Only the user minimising it is respected.
  const keeper = setInterval(() => {
    const w = overlayWindow;
    if (!w || w.isDestroyed()) return clearInterval(keeper);
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.showInactive(); // never steal the keyboard focus from the app being controlled
    if (overlayOnTop) {
      w.setAlwaysOnTop(true, "screen-saver");
      w.moveTop();
    }
  }, 400);
  overlayWindow.on("minimize", () => { if (overlayWindow && !overlayWindow.isDestroyed() && !overlayClosing) { overlayWindow.restore(); overlayWindow.showInactive(); } });
  overlayWindow.on("hide", () => { if (overlayWindow === null || overlayWindow.isDestroyed() || overlayClosing) return; setTimeout(() => { if (overlayWindow && !overlayWindow.isDestroyed() && !overlayClosing) overlayWindow.showInactive(); }, 50); });
  overlayWindow.webContents.on("render-process-gone", () => { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.reload(); });
  overlayWindow.on("closed", () => {
    clearInterval(keeper);
    overlayWindow = null;
  });
}

// Solving-real-world-problem look: the black Take Over circle and box become white, with a title on top.
const WORLD_CSS = "html[data-mode=world] body{filter:invert(1) hue-rotate(180deg)} #fx-world-title{position:fixed;top:0;left:0;right:0;z-index:99999;text-align:center;font:600 12px system-ui,sans-serif;padding:6px;background:#fff;color:#000;border:1px solid #000;border-radius:8px 8px 0 0;filter:invert(1) hue-rotate(180deg)}";
const WORLD_JS = "document.documentElement.dataset.mode='world';if(!document.getElementById('fx-world-title')){const t=document.createElement('div');t.id='fx-world-title';t.textContent='Solving real world problem';document.body.appendChild(t)}";
ipcMain.handle("overlay:open", (_event, task, options = {}) => {
  if (!mainWindow || !task || typeof task.text !== "string") return;
  const onTop = options.alwaysOnTop !== false;
  const send = () => overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.webContents.send("overlay:task", { id: String(task.id || ""), text: task.text.slice(0, 6000), resume: task.resume === true, mode: task.mode === "world" ? "world" : "normal" });
  const styleWorld = () => { if (task.mode !== "world" || !overlayWindow || overlayWindow.isDestroyed()) return; overlayWindow.webContents.insertCSS(WORLD_CSS).catch(() => {}); overlayWindow.webContents.executeJavaScript(WORLD_JS).catch(() => {}); };

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayOnTop = onTop;
    overlayWindow.setAlwaysOnTop(onTop, onTop ? "screen-saver" : "normal");
    overlayWindow.show();
    send();
    styleWorld();
  } else {
    createOverlayWindow(onTop);
    overlayWindow.webContents.once("did-finish-load", () => {
      send();
      styleWorld();
      overlayWindow.show();
    });
  }
  createTray();
  mainWindow.hide();
});

// The circle stays where it is: the left edge and the bottom edge stay fixed while the panel
// opens (to the right) or closes, and the panel grows upwards. If the panel would run off the
// screen, the whole thing is nudged back inside.
ipcMain.handle("overlay:resize", (_event, size) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || !size) return;
  const cur = overlayWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(cur);
  const width = Math.min(Math.max(Math.round(size.width) || 0, 48), workArea.width - 2 * OVERLAY_MARGIN);
  const height = Math.min(Math.max(Math.round(size.height) || 0, 48), workArea.height - 2 * OVERLAY_MARGIN);
  let x = cur.x;
  let y = cur.y + cur.height - height;
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
  y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
  overlayWindow.setBounds({ x, y, width, height });
});

// Reopen the complete interface. The circle and panel stay available, but no longer float above it.
ipcMain.handle("overlay:expand", () => {
  overlayOnTop = false;
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setAlwaysOnTop(false);
  showMain();
});

// Dismiss the Take Over window and return to the full interface.
ipcMain.handle("overlay:close", () => {
  destroyOverlay();
  showMain();
});

// The panel reports progress; the full interface keeps it in History.
ipcMain.handle("overlay:update", (_event, update) => {
  sendToWindow("overlay:event", update);
});

app.on("second-instance", () => showMain());

app.whenReady().then(() => {
  // Allow the microphone (offline voice input) for our own window only; deny every other permission.
  const ses = require("electron").session.defaultSession;
  const allowed = (wc, perm) => perm === "media" && mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(allowed(wc, perm)));
  ses.setPermissionCheckHandler((wc, perm) => !!wc && allowed(wc, perm));
  if (gotSingleInstanceLock) setupBackend();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
