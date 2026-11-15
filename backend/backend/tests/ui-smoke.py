"""FIDEX AI interface smoke test (Step 3, dark redesign).

Runs the real renderer in headless Chromium with a stand-in for the Electron bridge, walks
through the screens and saves screenshots to tests/screenshots/. The Take Over window
(overlay.html) is tested as its own page, exactly as Electron loads it.
It cannot test native Windows behaviour (transparent window, tray, taskbar icon): check those
by running `npm start`.

Setup (once):  pip install playwright   and   playwright install chromium
Run:           python tests/ui-smoke.py
"""
import pathlib, struct, json, re, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
REND = ROOT / "src" / "renderer"
INDEX = (REND / "index.html").as_uri()
OVERLAY = (REND / "overlay.html").as_uri()
SHOTS = ROOT / "tests" / "screenshots"
SHOTS.mkdir(exist_ok=True)

BRIDGE = """
window.__calls = [];
window.fidex = {
  getAppInfo: async () => ({version: '0.6.0', electron: '45.x', chrome: '140.x', node: '22.x'}),
  getTheme: async () => 'dark', onThemeChanged: () => {},
  minimizeWindow: async () => window.__calls.push('minimize'),
  toggleMaximizeWindow: async () => window.__calls.push('toggleMaximize'),
  closeWindow: async () => window.__calls.push('close'),
  onWindowState: (cb) => { window.__stateCb = cb; },
  openOverlay: async (t, o) => window.__calls.push('openOverlay:' + JSON.stringify({text: t.text, top: o.alwaysOnTop})),
  closeOverlay: async () => window.__calls.push('closeOverlay'),
  expandOverlay: async () => window.__calls.push('expandOverlay'),
  resizeOverlay: async (s) => { window.__calls.push('resizeOverlay'); window.__lastSize = s; },
  sendOverlayUpdate: async (u) => { window.__lastUpdate = u; },
  onOverlayTask: (cb) => { window.__taskCb = cb; },
  onOverlayEvent: (cb) => { window.__eventCb = cb; },
  backendRequest: async (t, p) => {
    window.__calls.push('backendRequest:' + t + ':' + JSON.stringify(p));
    return {ok: true, type: t, data: {reply: 'Python backend received: ' + p.message, brain_connected: false}};
  },
  getBackendStatus: async () => ({state: 'ready'}),
  onBackendStatus: () => () => {},
};
"""

results = []
errors = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + name + (f"  ({detail})" if detail else ""))

def overflow(page):
    return page.evaluate("""() => {
      const bad = [];
      const vw = document.documentElement.clientWidth;
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('[hidden]')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + 1 && !el.closest('.sidebar') && !el.closest('.sprite')) bad.push(el.className || el.tagName);
      }
      return {scrollX: document.documentElement.scrollWidth > vw + 1, bad: bad.slice(0, 3)};
    }""")

def rgb(s):
    return [int(x) for x in re.findall(r"\d+", s)[:3]]

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--allow-file-access-from-files"])
    ctx = browser.new_context(viewport={"width": 1100, "height": 720})
    ctx.add_init_script(BRIDGE)
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(INDEX)

    # ---------- 1. Welcome screen ----------
    print("\n-- Welcome screen")
    check("welcome visible first", page.is_visible("#welcome-view"))
    w = page.evaluate("""() => {
      const q = (s) => document.querySelector(s);
      const cs = (e) => getComputedStyle(e);
      const view = q('#welcome-view');
      const brand = q('#welcome-view .brand'), main = q('.brand-main'), sub = q('.brand-sub');
      const msg = q('#welcome-view .welcome'), credit = q('#welcome-view .credit');
      const vw = innerWidth;
      const mid = (e) => { const r = e.getBoundingClientRect(); return (r.left + r.right) / 2; };
      const all = [view, ...view.querySelectorAll('*')];
      return {
        bg: cs(view).backgroundColor,
        title: cs(document.getElementById('titlebar')).backgroundColor,
        mainColor: cs(main).color, subColor: cs(sub).color,
        brandSize: parseFloat(cs(brand).fontSize), msgSize: parseFloat(cs(msg).fontSize), creditSize: parseFloat(cs(credit).fontSize),
        brandMid: mid(brand), msgMid: mid(msg), vw,
        brandTop: brand.getBoundingClientRect().top, vh: innerHeight,
        creditRight: credit.getBoundingClientRect().right,
        msgText: msg.textContent, creditText: credit.textContent, brandText: brand.textContent.replace(/\\s+/g, ' ').trim(),
        fonts: all.map(e => cs(e).fontFamily).join('|'),
        italics: all.some(e => cs(e).fontStyle !== 'normal'),
        deco: all.some(e => cs(e).boxShadow !== 'none' || cs(e).textShadow !== 'none' || cs(e).backgroundImage !== 'none' || cs(e).animationName !== 'none' || cs(e).filter !== 'none'),
        children: [...view.children].map(e => e.tagName).join(','),
        extraMedia: view.querySelectorAll('img, svg, canvas, video').length,
      };
    }""")
    check("background is pure black", w["bg"] == "rgb(0, 0, 0)", w["bg"])
    check("title bar is black on welcome", w["title"] == "rgb(0, 0, 0)", w["title"])
    check("FIDEX AI is centred horizontally", abs(w["brandMid"] - w["vw"] / 2) < 2)
    check("FIDEX AI is centred vertically", abs((w["brandTop"] + 36) - w["vh"] / 2) < 60)
    check("'FIDEX' is white", w["mainColor"] == "rgb(255, 255, 255)", w["mainColor"])
    check("'AI' is grey", rgb(w["subColor"])[0] == rgb(w["subColor"])[1] == rgb(w["subColor"])[2] and 100 < rgb(w["subColor"])[0] < 200, w["subColor"])
    check("brand text is 'FIDEX AI'", w["brandText"].upper() == "FIDEX AI", w["brandText"])
    check("FIDEX AI is the largest text", w["brandSize"] > 2.5 * max(w["msgSize"], w["creditSize"]), f'{w["brandSize"]}px vs {w["msgSize"]}px')
    check("other text is small (<=13px)", w["msgSize"] <= 13 and w["creditSize"] <= 13)
    check("bottom-middle text exact", w["msgText"] == "Take a rest, CEO. Let's FIDEX AI take over.", w["msgText"])
    check("bottom-middle text is centred", abs(w["msgMid"] - w["vw"] / 2) < 2)
    check("bottom-right credit exact", w["creditText"] == "Built by Fidelis Francis", w["creditText"])
    check("credit sits bottom-right", w["vw"] - w["creditRight"] < 40)
    check("no serif / cursive / decorative fonts", not re.search(r"georgia|palatino|book antiqua|cursive|fantasy|times", w["fonts"], re.I) and not w["italics"], w["fonts"][:60])
    check("no glow, gradient, shadow, filter or animation", not w["deco"])
    check("no extra elements (only name + 2 lines, no logo)", w["children"] == "DIV,P,P" and w["extraMedia"] == 0, w["children"])
    css_other = "".join((REND / f).read_text() for f in ["styles.css", "workspace.css", "views.css", "home.css", "overlay.css"])
    check("welcome rules live only in welcome.css", ".welcome" not in css_other)
    page.screenshot(path=str(SHOTS / "01-welcome.png"))
    page.mouse.click(500, 300)
    page.wait_for_selector("#workspace-view:not([hidden])")
    check("click skips welcome to the workspace", page.is_visible("#view-home"))

    # ---------- 2. Home ----------
    print("\n-- Home / dark theme")
    page.screenshot(path=str(SHOTS / "02-home.png"))
    h = page.evaluate("""() => {
      const cs = (e) => getComputedStyle(e);
      const bodyBg = cs(document.body).backgroundColor;
      const texts = [...document.querySelectorAll('#view-home *')].filter(e => e.children.length === 0 && e.textContent.trim());
      return { bodyBg, maxFont: Math.max(...texts.map(e => parseFloat(cs(e).fontSize))), caps: document.querySelectorAll('.cap').length,
        q: document.querySelector('.assign-q').textContent, white: [...document.querySelectorAll('#workspace-view, .main, .sidebar')].some(e => cs(e).backgroundColor === 'rgb(255, 255, 255)') };
    }""")
    lum = sum(rgb(h["bodyBg"])) / 3
    check("main application is dark", lum < 30, h["bodyBg"])
    check("no white surfaces", not h["white"])
    check("no oversized text on home (<=19px)", h["maxFont"] <= 19, f'{h["maxFont"]}px')
    check("project prompt text exact", h["q"] == "Could you tell me about your project and share the important details I should understand before getting started?")
    check("eight capability cards", h["caps"] == 8)
    check("capabilities mention website building and customer communication", "Builds digital products" in page.inner_text(".caps") and "Talks to customers" in page.inner_text(".caps"))
    check("approval policy stated on home", "always wait for your approval" in page.inner_text("#home-cmd"))
    labels = [t.strip() for t in page.locator(".sidebar .nav-item span:first-of-type").all_inner_texts()]
    for want in ["Take Over", "Start Solving World Problems", "How to Use", "History", "Settings", "About"]:
        check(f"sidebar has '{want}'", want in labels)
    check("kite logo is white/grey only (no blue)", page.evaluate("""() => [...document.querySelectorAll('#logo-kite polygon')].every(p => ['#ffffff', '#bdbdbd'].includes(p.getAttribute('fill')))"""))
    empty = page.evaluate("""() => { const v = document.querySelector('#view-home .view-scroll'); return v.scrollHeight <= v.clientHeight + 2; }""")
    check("home fits at 1100x720 without scrolling (compact)", empty)

    # ---------- 3. Project input -> Take Over ----------
    print("\n-- Project input")
    check("submit disabled while empty", page.is_disabled("#home-cmd .cmd-send"))
    page.fill("#home-input", "Build and launch a website for my tailoring business")
    check("submit enabled after typing", page.is_enabled("#home-cmd .cmd-send"))
    page.screenshot(path=str(SHOTS / "03-home-typed.png"))
    page.press("#home-input", "Enter")
    calls = page.evaluate("window.__calls")
    check("assignment opens the Take Over window (bridge.openOverlay)", any(c.startswith("openOverlay") and "tailoring" in c for c in calls), str(calls))
    check("panel stays on top by default", any('"top":true' in c for c in calls))
    check("input cleared after submit", page.input_value("#home-input") == "")
    check("recent assignment listed on home", page.locator("#home-recent .mini-item").count() == 1)
    cmd_id = page.evaluate("JSON.parse(localStorage.getItem('fidex.takeover.v1'))[0].id")
    page.evaluate("(id) => window.__eventCb({id, status: 'done', stage: 'Completion and open issues', progress: 100, outstanding: ['x']})", cmd_id)
    check("panel progress is saved to the assignment", page.evaluate("JSON.parse(localStorage.getItem('fidex.takeover.v1'))[0].status") == "done")
    check("home shows the outcome", "Complete" in page.inner_text("#home-recent"))

    # ---------- 4. Take Over page ----------
    print("\n-- Take Over page")
    page.click(".nav-primary")
    check("Take Over page opens", page.is_visible("#view-takeover"))
    page.click("#takeover-examples .chip:first-child")
    check("example fills the box", page.input_value("#takeover-input") != "")
    page.click("#takeover-mic")
    check("mic says 'not available'", "not available" in page.inner_text("#toast"))
    page.screenshot(path=str(SHOTS / "04-takeover-page.png"))
    page.press("#takeover-input", "Enter")
    check("Take Over page submit opens the window", sum(c.startswith("openOverlay") for c in page.evaluate("window.__calls")) == 2)

    # ---------- 5. Other pages ----------
    print("\n-- World, How to Use, History, Settings, About")
    page.click(".nav-world")
    page.fill("#world-topic", "Access to clean drinking water")
    page.click("#world-start")
    check("World Problems placeholder works", page.is_visible("#world-result"))
    page.click(".nav-item[data-route=howto]")
    check("How to Use has 6 cards", page.locator(".guide-card").count() == 6)
    check("How to Use explains approvals and the panel", "Approvals" in page.inner_text("#view-howto") and "activity panel" in page.inner_text("#view-howto"))
    page.screenshot(path=str(SHOTS / "05-howto.png"))
    page.click(".brandbar .brand-text")
    page.click("#new-chat")
    page.fill("#input", "Hello FIDEX")
    page.press("#input", "Enter")
    page.wait_for_selector(".msg-ai")
    check("chat still works (placeholder reply)", "placeholder" in page.inner_text(".msg-ai").lower())
    check("conversation saved", page.evaluate("JSON.parse(localStorage.getItem('fidex.conversations.v1')).length") == 1)
    page.click(".nav-item[data-route=history]")
    check("history lists the conversation", page.locator("#history-chats .list-row").count() == 1)
    page.click("#tab-commands")
    check("history lists assignments with status", page.locator("#history-commands .list-row").count() >= 2 and "Complete" in page.inner_text("#history-commands"))
    page.screenshot(path=str(SHOTS / "06-history.png"))
    page.click("#history-commands .list-main")
    check("clicking an assignment reuses it", page.is_visible("#view-takeover") and page.input_value("#takeover-input") != "")
    page.click(".nav-item[data-route=settings]")
    check("settings use Take Over panel wording", "Take Over panel" in page.inner_text("#view-settings"))
    page.uncheck("#set-auto-compact")
    check("settings toggle persists", page.evaluate("JSON.parse(localStorage.getItem('fidex.settings.v1')).autoCompact") is False)
    page.screenshot(path=str(SHOTS / "07-settings.png"))
    before = sum(c.startswith("openOverlay") for c in page.evaluate("window.__calls"))
    page.click(".nav-item[data-route=takeover]")
    page.fill("#takeover-input", "panel switched off")
    page.press("#takeover-input", "Enter")
    check("panel off -> no window opened", sum(c.startswith("openOverlay") for c in page.evaluate("window.__calls")) == before and page.is_visible("#view-takeover"))
    page.click(".nav-item[data-route=settings]")
    page.check("#set-auto-compact")
    page.click("#clear-commands")
    check("clear assignments works", page.evaluate("JSON.parse(localStorage.getItem('fidex.takeover.v1')).length") == 0)
    page.click(".nav-item[data-route=about]")
    check("About shows version", page.inner_text("#about-version") == "0.6.0")
    page.click("#win-min"); page.click("#win-max")
    page.evaluate("window.__stateCb({maximized:true})")
    check("window controls call the bridge", {"minimize", "toggleMaximize"} <= set(page.evaluate("window.__calls")))
    page.click(".nav-item[data-route=settings]")
    page.click("#show-welcome")
    check("'Show welcome screen' returns to the black welcome", page.is_visible("#welcome-view") and page.evaluate("getComputedStyle(document.getElementById('welcome-view')).backgroundColor") == "rgb(0, 0, 0)")
    page.keyboard.press("Space")
    page.wait_for_selector("#workspace-view:not([hidden])")

    # ---------- 6. Responsive ----------
    print("\n-- Responsive")
    pages_ = ["home", "chat", "takeover", "world", "howto", "history", "settings", "about"]
    for w_, h_ in [(1400, 860), (1100, 720), (760, 600), (620, 520), (520, 480), (480, 420)]:
        page.set_viewport_size({"width": w_, "height": h_})
        bad_pages = []
        for name in pages_:
            if w_ <= 760:
                page.click("#menu-btn")
            if name == "home":
                page.click(".brandbar .brand-text")
            else:
                page.click(f".nav-item[data-route={'chat-new' if name == 'chat' else name}]")
            o = overflow(page)
            if o["scrollX"] or o["bad"]:
                bad_pages.append((name, o["bad"]))
        check(f"no sideways overflow at {w_}x{h_}", not bad_pages, str(bad_pages))
        if name == "about":
            page.click(".brandbar .brand-text") if w_ > 760 else None
    page.set_viewport_size({"width": 480, "height": 420})
    if page.is_visible("#menu-btn"):
        page.click("#menu-btn")
    page.click(".brandbar .brand-text") if page.is_visible(".brandbar .brand-text") else None
    page.screenshot(path=str(SHOTS / "08-home-small.png"))
    page.set_viewport_size({"width": 1100, "height": 720})

    # ---------- 7. Take Over window: circle + activity panel ----------
    print("\n-- Take Over window (overlay.html)")
    ov_ctx = browser.new_context(viewport={"width": 420, "height": 460})
    ov_ctx.add_init_script(BRIDGE)
    ov = ov_ctx.new_page()
    ov.on("console", lambda m: errors.append("overlay: " + m.text) if m.type in ("error", "warning") else None)
    ov.on("pageerror", lambda e: errors.append("overlay: " + str(e)))
    ov.goto(OVERLAY)
    ov.evaluate("document.documentElement.style.background = '#2b2b30'")  # makes the transparent window visible in screenshots
    ov.evaluate("window.__taskCb({id: 't1', text: 'Build and launch a website for my tailoring business'})")
    ov.wait_for_timeout(300)

    g = ov.evaluate("""() => {
      const cs = (e) => getComputedStyle(e);
      const orb = document.getElementById('ov-orb'), panel = document.getElementById('ov-panel');
      const o = orb.getBoundingClientRect(), p = panel.getBoundingClientRect();
      const blue = [...document.querySelectorAll('body *')].filter(e => { const m = ['color','backgroundColor','borderTopColor'].map(k => (cs(e)[k].match(/\\d+/g) || []).map(Number)); return m.some(c => c.length >= 3 && c[2] > c[0] + 25 && c[2] > c[1] + 25); }).length;
      return {
        orbW: o.width, orbH: o.height, orbRadius: cs(orb).borderRadius, orbBg: cs(orb).backgroundColor, orbShadow: cs(orb).boxShadow, orbFilter: cs(orb).filter,
        panelShadow: cs(panel).boxShadow, panelBg: cs(panel).backgroundColor, panelW: p.width, panelH: p.height,
        gap: p.left - o.right, panelRightOfOrb: p.left > o.right, nested: orb.contains(panel) || panel.contains(orb),
        sameBox: (o.left === p.left && o.top === p.top), blue,
        kite: orb.getBoundingClientRect().width, kiteW: orb.querySelector('svg').getBoundingClientRect().width,
        animations: [...document.querySelectorAll('#ov, #ov *')].some(e => cs(e).animationName !== 'none'),
        maxFont: Math.max(...[...document.querySelectorAll('#ov *')].filter(e => e.children.length === 0 && e.textContent.trim()).map(e => parseFloat(cs(e).fontSize))),
        bodyBg: cs(document.body).backgroundColor,
      };
    }""")
    check("logo circle is a true circle", abs(g["orbW"] - g["orbH"]) < 0.5 and g["orbRadius"] in ("50%", "22px"), f'{g["orbW"]}x{g["orbH"]} r={g["orbRadius"]}')
    check("logo circle is small (<=52px) with black background", g["orbW"] <= 52 and g["orbBg"] == "rgb(0, 0, 0)")
    check("logo circle has no glow or shadow", g["orbShadow"] == "none" and g["orbFilter"] == "none")
    check("logo is white/grey kite only, no blue anywhere", ov.evaluate("""() => [...document.querySelectorAll('#logo-kite polygon')].every(p => ['#ffffff', '#bdbdbd'].includes(p.getAttribute('fill')))""") and g["blue"] == 0, f'blue elements: {g["blue"]}')
    check("activity panel sits to the right of the circle", g["panelRightOfOrb"] and g["gap"] >= 6, f'gap {g["gap"]}px')
    check("circle and panel are separate elements (not nested)", not g["nested"] and not g["sameBox"])
    check("panel is small in height and wider than tall", g["panelH"] < 190 and g["panelW"] >= 300 and g["panelW"] > g["panelH"] * 1.6, f'{g["panelW"]}x{g["panelH"]}')
    check("panel has no shadow, dark background", g["panelShadow"] == "none" and sum(rgb(g["panelBg"])) / 3 < 25)
    check("no animation, compact type (<=13px)", not g["animations"] and g["maxFont"] <= 13, f'{g["maxFont"]}px')
    check("window background is transparent", g["bodyBg"] in ("rgba(0, 0, 0, 0)", "transparent"), g["bodyBg"])
    check("panel states what FIDEX AI is doing and the stage", ov.inner_text("#ov-doing").strip() != "" and "/" in ov.inner_text("#ov-count"))
    check("panel shows a short explanation", len(ov.inner_text("#ov-why").strip()) > 10)
    check("panel marked as simulated", "Simulated" in ov.inner_text("#ov-panel"))
    check("task text shown", "tailoring" in ov.inner_text("#ov-task"))
    check("window size is reported to Electron", ov.evaluate("window.__lastSize") is not None and ov.evaluate("window.__lastSize.width") > 300, str(ov.evaluate("window.__lastSize")))
    ov.screenshot(path=str(SHOTS / "09-takeover-start.png"))

    # details
    check("details start collapsed", ov.is_hidden("#ov-details"))
    h0 = ov.evaluate("window.__lastSize.height")
    ov.click("#ov-more")
    check("details expand", ov.is_visible("#ov-details") and ov.locator("#ov-steps li").count() == 6)
    ov.wait_for_timeout(150)
    check("window grows with details", ov.evaluate("window.__lastSize.height") > h0)
    check("current step is marked active", ov.locator("#ov-steps li.active").count() == 1)
    ov.screenshot(path=str(SHOTS / "10-takeover-details.png"))
    ov.click("#ov-more")
    check("details collapse again", ov.is_hidden("#ov-details"))

    # questions
    ov.wait_for_selector("#ov-requests .req", timeout=9000)
    check("asks for the project folder", "project folder" in ov.inner_text("#ov-requests"))
    check("input is addressed to the question", "folder" in ov.get_attribute("#ov-input", "placeholder").lower() and "Replying to" in ov.inner_text("#ov-target"))
    stage_before = ov.inner_text("#ov-stage")
    ov.screenshot(path=str(SHOTS / "11-takeover-question.png"))
    ov.fill("#ov-input", "D:\\Projects\\TailorSite")
    ov.press("#ov-input", "Enter")
    check("answer removes the question", "project folder" not in ov.inner_text("#ov-requests").lower())
    ov.click("#ov-more")
    check("answer is logged", "You answered" in ov.inner_text("#ov-log"))
    ov.click("#ov-more")
    p0 = int(ov.get_attribute(".p-bar", "aria-valuenow"))
    ov.wait_for_timeout(2500)
    p1 = int(ov.get_attribute(".p-bar", "aria-valuenow"))
    check("task keeps going while questions are answered", p1 > p0 or ov.inner_text("#ov-stage") != stage_before, f"{p0}% -> {p1}%")

    # general note, other questions open
    ov.wait_for_selector("#ov-requests .req:has-text('target audience')", timeout=8000)
    ov.click("#ov-target-clear")
    check("'General note' switches the input", ov.is_hidden("#ov-target") and "instruction" in ov.get_attribute("#ov-input", "placeholder"))
    ov.fill("#ov-input", "Use a dark theme and keep the layout compact")
    ov.press("#ov-input", "Enter")
    ov.click("#ov-more")
    check("free-form note is accepted without stopping the task", "You added" in ov.inner_text("#ov-log") and "audience" in ov.inner_text("#ov-requests"))
    ov.click("#ov-more")

    # answering a different question by clicking it
    ov.click("#ov-requests .req:has-text('target audience')")
    check("clicking a question targets it", "audience" in ov.inner_text("#ov-target"))
    ov.fill("#ov-input", "Local customers aged 25 to 55")
    ov.press("#ov-input", "Enter")
    ov.fill("#ov-input", "@tailor_studio")
    ov.press("#ov-input", "Enter")
    check("all questions can be answered in any order", ov.locator("#ov-requests .req:not(:has(.req-btn))").count() == 0)

    # hide panel -> circle only, request badge
    ov.click("#ov-hide")
    check("hide leaves only the circle", ov.is_hidden("#ov-panel") and ov.is_visible("#ov-orb"))
    ov.wait_for_timeout(300)
    check("window shrinks to the circle", ov.evaluate("window.__lastSize.width") <= 56 and ov.evaluate("window.__lastSize.height") <= 56, str(ov.evaluate("window.__lastSize")))
    ov.screenshot(path=str(SHOTS / "12-takeover-circle-only.png"))

    # approval arrives while hidden: panel returns, task blocked
    ov.wait_for_selector("#ov-panel", state="visible", timeout=12000)
    ov.wait_for_selector("#ov-requests .req-btn.primary", timeout=8000)
    check("a new request reopens the hidden panel", ov.is_visible("#ov-panel"))
    check("approval is required for publishing", "approval required" in ov.inner_text("#ov-requests").lower() and "Publish" in ov.inner_text("#ov-requests"))
    ov.screenshot(path=str(SHOTS / "13-takeover-approval.png"))
    ov.wait_for_timeout(3500)
    check("consequential action is NOT performed without approval", "Complete" not in ov.inner_text("#ov-stage") and ov.get_attribute(".p-bar", "aria-valuenow") != "100")
    check("panel says it is waiting for the user", "approval" in ov.inner_text("#ov-why").lower())
    ov.click("#ov-requests .req-btn.primary")
    ov.wait_for_selector("#ov-stage:text-is('Complete')", timeout=8000)
    check("task completes after approval", ov.inner_text("#ov-doing") == "Preview complete" and ov.is_disabled("#ov-input"))
    check("completion reported to the main window", ov.evaluate("window.__lastUpdate.status") == "done")
    ov.screenshot(path=str(SHOTS / "14-takeover-complete.png"))

    # reopen / close
    ov.click("#ov-open")
    check("open-full-interface button calls Electron", "expandOverlay" in ov.evaluate("window.__calls"))
    ov.dblclick("#ov-orb")
    check("circle double-click also reopens the interface", ov.evaluate("window.__calls.filter(c => c === 'expandOverlay').length") >= 2)
    ov.click("#ov-orb")
    check("circle click toggles panel", ov.is_hidden("#ov-panel"))
    ov.click("#ov-orb")
    check("circle click shows panel again", ov.is_visible("#ov-panel"))
    ov.keyboard.press("Escape")
    check("Escape hides the panel", ov.is_hidden("#ov-panel"))
    ov.click("#ov-orb")

    # decline path + stop
    ov.evaluate("window.__taskCb({id: 't2', text: 'Promote my product on social media'})")
    ov.wait_for_selector("#ov-requests .req:has-text('project folder')", timeout=9000)
    ov.fill("#ov-input", "D:\\Projects\\Promo")
    ov.press("#ov-input", "Enter")
    ov.wait_for_selector("#ov-requests .req-btn.primary", timeout=15000)
    ov.click("#ov-requests .req-btn:not(.primary)")
    ov.wait_for_selector("#ov-requests .req:has(.req-btn)", state="detached", timeout=3000)
    check("declining an approval is possible", True)
    ov.click("#ov-more")
    ov.wait_for_selector("#ov-stage:text-is('Complete')", timeout=14000)
    check("outstanding issues reported on completion", "Publishing was declined" in ov.inner_text("#ov-outstanding") or "declined" in ov.inner_text("#ov-outstanding").lower(), ov.inner_text("#ov-outstanding")[:80])
    ov.evaluate("window.__taskCb({id: 't3', text: 'Short task'})")
    ov.wait_for_timeout(500)
    ov.click("#ov-more")
    ov.click("#ov-stop")
    check("Stop works", ov.inner_text("#ov-stage") == "Stopped" and ov.evaluate("window.__lastUpdate.status") == "stopped")
    ov.evaluate("window.__taskCb({id: 't4', text: 'Close test'})")
    ov.wait_for_timeout(300)
    ov.click("#ov-close")
    check("close button stops the task and closes the window", "closeOverlay" in ov.evaluate("window.__calls"))

    # narrow-screen behaviour of the panel (e.g. very small display)
    ov.set_viewport_size({"width": 300, "height": 300})
    check("window content never exceeds its window width requirement", ov.evaluate("window.__lastSize.width") <= 400)
    ov_ctx.close()

    # ---------- 8. Windows application icon ----------
    print("\n-- Windows icon")
    ico = (ROOT / "assets" / "icons" / "icon.ico").read_bytes()
    count = struct.unpack("<H", ico[4:6])[0]
    sizes = sorted({(ico[6 + 16 * i] or 256) for i in range(count)})
    check("icon.ico is a valid multi-size icon", ico[:4] == b"\x00\x00\x01\x00" and 16 in sizes and 256 in sizes, str(sizes))
    main_js = (ROOT / "src" / "main" / "main.js").read_text()
    pkg = json.loads((ROOT / "package.json").read_text())
    check("main.js uses the icon for the main and Take Over windows", main_js.count("icon: windowIcon") == 2)
    check("package.json points the installer at icon.ico", pkg["build"]["win"]["icon"] == "assets/icons/icon.ico")
    check("Take Over window is transparent, frameless, shadowless", all(k in main_js for k in ["transparent: true", "frame: false", "hasShadow: false"]))

    # ---------- Step 4: the interface sends its startup message to the Python backend ----------
    print("\n-- Python backend link (Step 4)")
    calls = page.evaluate("window.__calls")
    check("startup sends 'Hello from FIDEX AI' to the Python backend", any(c == 'backendRequest:hello:{"message":"Hello from FIDEX AI"}' for c in calls))

    browser.close()

real_errors = [e for e in errors if "favicon" not in e.lower()]
check("no console errors or warnings", not real_errors, "; ".join(real_errors[:3]))
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
