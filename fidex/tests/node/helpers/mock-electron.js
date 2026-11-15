"use strict";
// A faithful stand-in for the parts of Electron that main.js and preload.js use, so the REAL
// main.js, preload.js, backend-ipc.js and python-bridge.js can run under plain Node.
//
// What it imitates on purpose:
//  - ipcRenderer.invoke -> ipcMain.handle: arguments and results go through structuredClone, so
//    anything Electron could not send (functions, circular objects...) fails here too.
//  - contextBridge.exposeInMainWorld: records the API the page would see.
//  - webContents.send -> ipcRenderer.on listeners of that window.
// What it cannot prove: Electron's own native behaviour (that is what `npm run test:e2e` is for).

const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const ROOT = path.join(__dirname, "..", "..", "..");
const projectFiles = (root) =>
  [
    "src/main/main.js",
    "src/main/python-bridge.js",
    "src/main/python-locator.js",
    "src/main/backend-ipc.js",
    "src/main/logger.js",
    "src/preload/preload.js",
  ].map((f) => path.join(root, f));

function createMockElectron({ userData }) {
  const ipcHandlers = new Map();
  const windows = [];
  const exposed = {};
  const rendererListeners = new Map(); // `${windowId}:${channel}` -> Set<fn>
  let activeRenderer = null; // the window whose renderer the preload belongs to

  class WebContents extends EventEmitter {
    constructor(win) {
      super();
      this.win = win;
      this.sent = [];
    }
    send(channel, payload) {
      const data = structuredClone(payload);
      this.sent.push({ channel, payload: data });
      for (const fn of rendererListeners.get(`${this.win.id}:${channel}`) || []) fn({}, data);
    }
    once(name, fn) {
      super.once(name, fn);
    }
  }

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.id = windows.length + 1;
      this.options = options;
      this.webContents = new WebContents(this);
      this.destroyed = false;
      this.visible = false;
      windows.push(this);
    }
    static getAllWindows() {
      return windows.filter((w) => !w.destroyed);
    }
    loadFile(file) {
      this.loadedFile = file;
      setImmediate(() => this.webContents.emit("did-finish-load"));
    }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    restore() {}
    minimize() {}
    maximize() {}
    unmaximize() {}
    isMaximized() { return false; }
    isMinimized() { return false; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { x: 0, y: 0, width: 1100, height: 720 }; }
    setBounds() {}
    setAlwaysOnTop() {}
    close() { this.destroy(); this.emit("closed"); }
    destroy() { this.destroyed = true; }
  }

  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    quitCalls: 0,
    exited: false,
    requestSingleInstanceLock: () => true,
    setAppUserModelId() {},
    getVersion: () => "0.8.0",
    // userData is where the real app keeps its database (see main.js, FIDEX_DATA_DIR)
    getPath: (name) => (name === "userData" ? userData : path.join(os.tmpdir(), `fidex-mock-${name}`)),
    whenReady: () => Promise.resolve(),
    quit() {
      app.quitCalls++;
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      app.emit("before-quit", event);
      if (!event.prevented) app.emit("will-quit", {});
    },
  });

  const ipcMain = {
    handle: (channel, fn) => ipcHandlers.set(channel, fn),
    handlers: ipcHandlers,
  };

  const ipcRenderer = {
    async invoke(channel, ...args) {
      const cloned = structuredClone(args); // throws like Electron if something cannot be sent
      const handler = ipcHandlers.get(channel);
      if (!handler) throw new Error(`Error invoking remote method '${channel}': No handler registered for '${channel}'`);
      const result = await handler({ sender: activeRenderer.webContents }, ...cloned);
      return result === undefined ? undefined : structuredClone(result);
    },
    on(channel, fn) {
      const key = `${activeRenderer.id}:${channel}`;
      if (!rendererListeners.has(key)) rendererListeners.set(key, new Set());
      rendererListeners.get(key).add(fn);
    },
    removeListener(channel, fn) {
      const set = rendererListeners.get(`${activeRenderer.id}:${channel}`);
      if (set) set.delete(fn);
    },
  };

  const contextBridge = { exposeInMainWorld: (name, api) => { exposed[name] = api; } };

  const nativeTheme = Object.assign(new EventEmitter(), { themeSource: "system", shouldUseDarkColors: true });
  const electron = {
    app,
    BrowserWindow,
    ipcMain,
    ipcRenderer,
    contextBridge,
    nativeTheme,
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
  };

  return {
    electron,
    windows,
    exposed,
    ipcHandlers,
    setActiveRenderer: (win) => { activeRenderer = win; },
  };
}

/**
 * Load the real main process + preload under the mock. Returns handles for the test.
 *
 * @param {object}  [options]
 * @param {string}  [options.root]      project folder to load main.js/preload.js from (default: this
 *                                      project). Lets a test run the real code from a copy that has no
 *                                      backend/.venv, see helpers/no-python.js.
 * @param {string}  [options.userData]  Electron "userData" folder. Default: a fresh temporary folder
 *                                      that dispose() deletes. Pass your own to close and reopen the app
 *                                      on the same data (the folder is then yours to delete).
 */
async function loadApp({ root = ROOT, userData } = {}) {
  const ownsUserData = !userData;
  userData = userData || fs.mkdtempSync(path.join(os.tmpdir(), "fidex-userdata-"));
  const PROJECT_FILES = projectFiles(root);
  const mock = createMockElectron({ userData });
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return mock.electron;
    return originalLoad.apply(this, arguments);
  };
  for (const f of PROJECT_FILES) delete require.cache[f];

  require(path.join(root, "src/main/main.js"));
  await new Promise((r) => setImmediate(r)); // let app.whenReady().then(...) run
  const mainWindow = mock.windows[0];
  if (!mainWindow) throw new Error("main.js did not create the main window");

  mock.setActiveRenderer(mainWindow);
  require(path.join(root, "src/preload/preload.js"));

  return {
    ...mock,
    mainWindow,
    api: mock.exposed.fidex,
    app: mock.electron.app,
    userData,
    /** undo the module hook and forget the loaded files (and delete a userData folder we created) */
    dispose() {
      Module._load = originalLoad;
      for (const f of PROJECT_FILES) delete require.cache[f];
      if (ownsUserData) fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

module.exports = { loadApp };
