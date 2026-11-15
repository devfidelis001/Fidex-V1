# Step 3 delivery: FIDEX AI dark redesign (v0.6.0)

## Install (PowerShell, from the project folder)
1. Unzip, keeping the folder structure. Close any open FIDEX AI window first (only one can run).
2. First time only: `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`
   (Already set up? Run `npm install` only if `node_modules` is missing.)
3. Check: `npm run verify`
4. Start: `npm start`

## What changed
- **Welcome screen**: pure black. "FIDEX" white, "AI" grey, centred and by far the largest text. Bottom middle: "Take a rest, CEO. Let's FIDEX AI take over." Bottom right: "Built by Fidelis Francis". Sans-serif only, small bottom text, no glow, gradient, shadow, animation or extra elements. All of it lives in `src/renderer/welcome.css`, which uses fixed values and none of the theme tokens, so the main theme cannot affect it. Click or press any key to skip; it also opens the app by itself after 3.5 s.
- **Dark theme** for the whole application: black and charcoal surfaces, white / silver / grey type, small compact elements, subtle borders, no shadows.
- **Kite logo**: kite symbol only, white and grey, no blue, no glow, no animation.
- **Home**: short executive-agent introduction, the central project input with the prompt "Could you tell me about your project...", eight capability cards, a "how work flows" panel and recent assignments.
- **Take Over** (completely redesigned): sending an assignment hides the full window and opens a separate transparent window with two independent elements:
  - a small black circle with the white/grey kite, no glow;
  - a compact activity panel to its right: current stage and action, a short explanation, a progress bar, expandable task details (steps and activity log), questions that need you, approval requests, and an input where you add information or instructions while the task continues.
  - Click the circle to hide or show the panel (a white dot shows a question is waiting). Open the full interface with the panel's expand button, a double-click on the circle, or the tray icon.
- **Approvals**: publishing, sending, spending, deleting and external commitments stop and wait for Approve / Decline in the panel.
- **History** now shows the outcome of each assignment. Settings, How to Use and About are updated for the new flow.

## Simulation only
`src/renderer/js/agent-sim.js` plays a scripted workflow (understand, identify needs, plan, execute, report, complete) with a folder question, an audience question, a social media account question and a publish approval. It executes nothing. No Ollama, no AI reasoning, no real automation, no voice. The real agent will replace this one file.

## Windows icon
`assets/icons/icon.ico` (white kite on black, 16 to 256 px) is the window, Take Over window and tray icon, and the installer icon in `package.json`. With `npm start`, the file `electron.exe` in `node_modules` keeps Electron's own icon; only a packaged build replaces it.

## Files changed
Changed: `package.json`, `README.md`, `scripts/verify-env.js`, `src/main/main.js`, `src/preload/preload.js`, `src/renderer/index.html`, `src/renderer/renderer.js`, `src/renderer/styles.css`, `src/renderer/workspace.css`, `src/renderer/views.css`, `src/renderer/js/bridge.js`, `src/renderer/js/history.js`, `src/renderer/js/takeover.js`, `src/renderer/js/titlebar.js`, `tests/ui-smoke.py`, `docs/STEP3-DELIVERY.md`

New: `src/renderer/welcome.css`, `src/renderer/home.css`, `src/renderer/overlay.html`, `src/renderer/overlay.css`, `src/renderer/js/overlay.js`, `src/renderer/js/agent-sim.js`

Removed (replaced by the Take Over window): `src/renderer/compact.css`, `src/renderer/js/compact.js`

Unchanged: `backend/`, `data/`, `assets/icons/*`, `src/renderer/js/{chat,responder,storage,router,sidebar,commandbox,settings,world,about,toast}.js`, `scripts/setup.ps1`, `scripts/verify_env.py`. Saved conversations, assignments and settings keep their storage keys.

## Tests
`python tests/ui-smoke.py` (needs `pip install playwright` and `playwright install chromium`): 119 checks across the welcome screen, home, project input, Take Over page, the circle and panel, History, Settings, responsive sizes and the icon file. Native Windows behaviour (transparent window, tray, taskbar icon) can only be checked by running `npm start`.
