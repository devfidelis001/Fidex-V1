"use strict";
// OPTIONAL end-to-end test (needs Playwright + Chromium, same as tests/ui-smoke.py):
//
//   npm install --no-save playwright && npx playwright install chromium
//   npm run test:renderer
//
// The REAL interface (index.html + renderer.js + js/*.js) runs in Chromium. The page's
// `window.fidex` is the REAL preload API, whose IPC calls are served by the REAL main.js,
// python-bridge.js and a REAL Python process. Only Electron's own transport is imitated.
// Checks that the interface (a) gets Python's answer, (b) copes when Python is unavailable,
// (c) still works in a plain browser, and (d) shows nothing new on screen.

const path = require("path");
const fs = require("fs");
const os = require("os");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  console.log("SKIP  Playwright is not installed (npm install --no-save playwright). Renderer test not run.");
  process.exit(0);
}

process.env.FIDEX_BACKEND_TEST = "1";
process.env.FIDEX_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fidex-logs-"));
const { loadApp } = require("../node/helpers/mock-electron");

const INDEX = "file://" + path.join(__dirname, "..", "..", "src", "renderer", "index.html").replace(/\\/g, "/");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

// window.fidex stand-in for everything except the backend calls (those go to the real preload API)
const baseApi = `
  window.fidex = {
    getAppInfo: async () => ({version:'0.8.0', electron:'x', chrome:'x', node:'x'}),
    getTheme: async () => 'dark', onThemeChanged: () => {},
    minimizeWindow: async () => {}, toggleMaximizeWindow: async () => {}, closeWindow: async () => {},
    onWindowState: () => {}, openOverlay: async () => {}, closeOverlay: async () => {}, expandOverlay: async () => {},
    resizeOverlay: async () => {}, sendOverlayUpdate: async () => {}, onOverlayTask: () => {}, onOverlayEvent: () => {},
    backendRequest: (t, p) => window.__backendRequest(t, p),
    getBackendStatus: () => window.__backendStatus(),
    onBackendStatus: () => () => {},
  };`;

async function openPage(browser, { backendRequest, backendStatus, withElectron = true }) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  const logs = [];
  const pageErrors = [];
  page.on("console", (m) => logs.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  if (withElectron) {
    await page.exposeFunction("__backendRequest", backendRequest);
    await page.exposeFunction("__backendStatus", backendStatus || (async () => null));
    await context.addInitScript(baseApi);
  }
  await page.goto(INDEX);
  return { page, logs, pageErrors, context };
}

(async () => {
  const restore = console.log;
  console.log = () => {}; // silence the main-process logger while the app loads
  const app = await loadApp();
  console.log = restore;
  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  try {
    // ---- 1. real chain: renderer -> preload API -> IPC -> main -> bridge -> Python ----
    console.log("\n-- Interface talks to the real Python backend");
    const a = await openPage(browser, { backendRequest: (t, p) => app.api.backendRequest(t, p), backendStatus: () => app.api.getBackendStatus() });
    const got = await waitFor(() => a.logs.some((l) => l.text.includes("[backend] Python replied")));
    const line = (a.logs.find((l) => l.text.includes("[backend] Python replied")) || {}).text || "";
    check("interface received Python's reply on startup", got, line);
    check("reply is the correct echo of 'Hello from FIDEX AI'", line.includes("Python backend received: Hello from FIDEX AI"));
    check("reply says the AI brain is NOT connected", line.includes("brain connected: false"));
    const direct = await a.page.evaluate(() => window.fidex.backendRequest("hello", { message: "Hello from FIDEX AI" }));
    check("page can send its own request and read the answer", direct.ok === true && direct.data.received === "Hello from FIDEX AI");
    const bad = await a.page.evaluate(() => window.fidex.backendRequest("hello", { message: 42 }));
    check("invalid request comes back as a clean error", bad.ok === false && bad.error.code === "INVALID_PAYLOAD");
    check("welcome screen still shown, nothing about the backend drawn on screen", await a.page.evaluate(() => {
      const v = document.querySelector("#welcome-view");
      return !v.hidden && getComputedStyle(v).display !== "none" && !/python|backend/i.test(document.body.innerText);
    }));
    check("no page errors or console warnings/errors", a.pageErrors.length === 0 && !a.logs.some((l) => l.type === "error" || l.type === "warning"), a.pageErrors.concat(a.logs.filter((l) => ["error", "warning"].includes(l.type)).map((l) => l.text)).join("; "));
    await a.context.close();

    // ---- 2. Python unavailable ----
    console.log("\n-- Python unavailable");
    const failure = { ok: false, type: "hello", error: { code: "BACKEND_UNAVAILABLE", message: "Could not start the Python backend." } };
    const b = await openPage(browser, { backendRequest: async () => failure });
    const warned = await waitFor(() => b.logs.some((l) => l.text.includes("request failed: BACKEND_UNAVAILABLE")));
    check("interface logs the failure instead of breaking", warned);
    check("no uncaught errors, interface still usable", b.pageErrors.length === 0 && (await b.page.isVisible("#welcome-view")));
    await b.page.keyboard.press("Space");
    check("can still leave the welcome screen", await waitFor(async () => !(await b.page.isVisible("#welcome-view")), 3000));
    await b.context.close();

    // ---- 3. malformed answer from the bridge ----
    console.log("\n-- Malformed answer");
    const c = await openPage(browser, { backendRequest: async () => "garbage" });
    check("garbage answer is handled", await waitFor(() => c.logs.some((l) => l.text.includes("BAD_RESPONSE"))) && c.pageErrors.length === 0);
    await c.context.close();

    // ---- 4. plain browser (no Electron) ----
    console.log("\n-- Plain browser, no Electron");
    const d = await openPage(browser, { withElectron: false });
    check("interface loads and skips the backend quietly", await waitFor(() => d.logs.some((l) => l.text.includes("Not running inside the desktop app"))) && d.pageErrors.length === 0);
    await d.context.close();
  } finally {
    await browser.close();
    app.dispose();
    await app.app.emit("before-quit", { preventDefault() {} });
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  setTimeout(() => process.exit(failed ? 1 : 0), 400);
})().catch((e) => {
  console.error("FAIL  test crashed:", e);
  process.exit(1);
});
