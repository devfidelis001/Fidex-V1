"""Stop Generation + Mind removal, tested in the real renderer (headless Chromium) with a stand-in Electron bridge.
The stand-in 'model' keeps generating until chat.cancel arrives, like the real backend.
Run:  python tests/ui-stop.py"""
import pathlib, sys, time
from playwright.sync_api import sync_playwright

INDEX = (pathlib.Path(__file__).resolve().parent.parent / "src" / "renderer" / "index.html").as_uri()

BRIDGE = """
window.__calls = []; window.__streams = {}; window.__mode = 'hang';
window.fidex = {
  getAppInfo: async () => ({version: 't', electron: 't', chrome: 't', node: 't'}),
  getTheme: async () => 'dark', onThemeChanged: () => {},
  minimizeWindow: async () => {}, toggleMaximizeWindow: async () => {}, closeWindow: async () => {},
  onWindowState: () => {}, openOverlay: async () => {}, closeOverlay: async () => {}, expandOverlay: async () => {},
  resizeOverlay: async () => {}, sendOverlayUpdate: async () => {}, onOverlayTask: () => {}, onOverlayEvent: () => {},
  getBackendStatus: async () => ({state: 'ready'}), onBackendStatus: () => () => {}, onBackendEvent: () => () => {},
  backendRequest: (type, p) => {
    window.__calls.push({type, p});
    if (type === 'chat.stream') {
      return new Promise((resolve) => {
        window.__streams[p.stream_id] = resolve;
        if (window.__mode === 'finish') setTimeout(() => resolve({ok: true, type, data: {text: 'Final answer.', model: 'qwen3.5:4b'}}), 150);
      });
    }
    if (type === 'chat.cancel') {
      const r = window.__streams[p.stream_id];
      if (r) setTimeout(() => r({ok: true, type: 'chat.stream', data: {text: 'partial', cancelled: true}}), 30);
      return Promise.resolve({ok: true, type, data: {cancelled: true}});
    }
    return Promise.resolve({ok: true, type, data: {text: '', loaded: true, tasks: []}});
  },
};
"""

def wait_label(page, want, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if page.get_attribute("#send", "aria-label") == want:
            return True
        time.sleep(0.01)
    raise AssertionError(f"button never became {want}")

def wait_text(page, text, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if text in page.inner_text("#messages"):
            return True
        time.sleep(0.02)
    raise AssertionError(f"never saw {text!r}")

results = []
def check(name, ok, detail=""):
    results.append(bool(ok)); print(("PASS  " if ok else "FAIL  ") + name + (f"  ({detail})" if detail else ""))

with sync_playwright() as p:
    b = p.chromium.launch(args=["--allow-file-access-from-files"]); page = b.new_page(viewport={"width": 1100, "height": 720})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.add_init_script(BRIDGE)
    page.goto(INDEX); page.mouse.click(500, 300); page.wait_for_selector("#workspace-view:not([hidden])")
    page.click(".nav-item[data-route=chat-new]")
    label = lambda: page.get_attribute("#send", "aria-label")
    icon = lambda: page.get_attribute("#send use", "href")
    check("idle: button is Send", label() == "Send" and icon() == "#i-send" and page.is_disabled("#send"))

    # --- Stop while generating ---
    page.fill("#input", "write a very long story"); page.press("#input", "Enter")
    wait_label(page, "Stop")
    check("generating: Send replaced by Stop", label() == "Stop" and icon() == "#i-stop" and page.is_enabled("#send"))
    check("no FIDEX MIND element anywhere", "FIDEX MIND" not in page.inner_text("body") and page.locator(".ai-mind").count() == 0)
    check("live card shows only YOUR RESPONSE", "YOUR RESPONSE" in page.inner_text(".msg-thinking") and page.locator(".msg-thinking .ai-dot").count() == 1)
    page.fill("#input", "a second message"); page.press("#input", "Enter")
    check("Enter does not send a new message while generating", page.evaluate("window.__calls.filter(c => c.type === 'chat.stream').length") == 1 and page.input_value("#input") == "a second message")
    t0 = time.time(); page.click("#send")
    wait_label(page, "Send")
    check("Stop restores Send at once", time.time() - t0 < 0.5 and icon() == "#i-send", f"{time.time()-t0:.2f}s")
    cancel = page.evaluate("window.__calls.filter(c => c.type === 'chat.cancel')")
    stream = page.evaluate("window.__calls.filter(c => c.type === 'chat.stream')[0]")
    check("chat.cancel sent for that stream", len(cancel) == 1 and cancel[0]["p"]["stream_id"] == stream["p"]["stream_id"])
    check("live card removed, stop note shown, partial text dropped", page.locator(".msg-thinking").count() == 0 and "Generation stopped." in page.inner_text("#messages") and "partial" not in page.inner_text("#messages"))
    check("typed text kept and Send enabled for a new message", page.input_value("#input") == "a second message" and page.is_enabled("#send"))

    # --- New message after Stop, finishing normally ---
    page.evaluate("window.__mode = 'finish'")
    page.press("#input", "Enter")
    wait_text(page, "Final answer.")
    check("new message after Stop is answered", True)
    check("Send is back after a finished answer", label() == "Send" and page.locator(".msg-ai .ai-card").count() >= 1 and "FIDEX MIND" not in page.inner_text("body"))
    memory = page.evaluate("window.__calls.filter(c => c.type === 'chat.stream')[1].p.messages.map(m => m.content)")
    check("stopped note is not fed back to the AI as memory", "Generation stopped." not in memory, str(memory))

    # --- Stop pressed right away, same question re-sent ---
    page.evaluate("window.__mode = 'hang'")
    page.fill("#input", "same question"); page.press("#input", "Enter")
    wait_label(page, "Stop")
    page.click("#send"); wait_label(page, "Send")
    page.fill("#input", "same question"); page.press("#input", "Enter")
    wait_label(page, "Stop")
    check("the same question can be asked again after Stop", page.evaluate("window.__calls.filter(c => c.type === 'chat.stream').length") >= 4)
    page.click("#send"); wait_label(page, "Send")
    check("no page errors", not errors, "; ".join(errors))
    b.close()

print(f"\n{sum(results)}/{len(results)} passed"); sys.exit(0 if all(results) else 1)
