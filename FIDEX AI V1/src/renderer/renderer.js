"use strict";

// Entry point of the interface. It creates each module and wires them together.
// Feature code lives in js/; this file only connects the pieces.

import { loadConversations, saveConversations, newId, makeTitle } from "./js/storage.js";
import { getReply, fetchFindings, resetChatState } from "./js/responder.js";
import { createImageAttach } from "./js/image-attach.js";
import { initSpeedX, hideBarLater, afterReply, paintBar, LABEL as SPEEDX_LABEL } from "./js/speedx.js";
import { createChat } from "./js/chat.js";
import { tts } from "./js/listen.js";
import { createSidebar, renderRecentChats } from "./js/sidebar.js";
import { createRouter } from "./js/router.js";
import { createViews } from "./js/views.js";
import { createToast } from "./js/toast.js";
import { createTitlebar } from "./js/titlebar.js";
import { bridge } from "./js/bridge.js";
import { createHistory } from "./js/history.js";
import { createAbout } from "./js/about.js";
import { checkBackendConnection } from "./js/backend-link.js";
import { createProfile } from "./js/profile.js";
import { runFirstRun } from "./js/first-run.js";
import { initProfile, resetProfile } from "./js/storage.js";

const $ = (id) => document.getElementById(id);
const q = (sel, root = document) => root.querySelector(sel);

let conversations = loadConversations(); // newest first
let activeId = null; // null = a new chat that has no messages yet

const findActive = () => conversations.find((c) => c.id === activeId) || null;
const persistChats = () => saveConversations(conversations.map((c) => ({ ...c, messages: c.messages.map((m) => (m.genImage ? { ...m, genImage: undefined, genGone: true } : m)) }))); // generated pictures are large: kept for the session, not in saved chats

const toast = createToast($("toast"));

// ---------- Sidebar (narrow-window slide-over) ----------
const sidebar = createSidebar({ workspaceEl: $("workspace-view"), backdropEl: $("sidebar-backdrop") });
$("sidebar-close").addEventListener("click", () => sidebar.closePanel());

// Recent chats: the 3 latest saved conversations. Clicking one restores its history and lets you keep chatting.
const renderSidebarChats = () =>
  renderRecentChats($("recent-chats"), $("recent-chats-empty"), conversations, router.current() === "chat" ? activeId : null, (id) => {
    activeId = id;
    router.go("chat");
    chat.focus();
  });

// ---------- Chat ----------
const attachErrEl = $("attach-error");
let attachErrTimer = 0;
const attach = createImageAttach({
  buttonEl: $("chat-attach"), fileEl: $("chat-file"), previewEl: $("attach-preview"), inputEl: $("input"), dropEl: $("view-chat"),
  onChange: () => { if (typeof chat !== "undefined") chat.syncSend(); },
  onError: (msg) => { attachErrEl.textContent = msg; attachErrEl.hidden = false; clearTimeout(attachErrTimer); attachErrTimer = setTimeout(() => { attachErrEl.hidden = true; }, 6000); },
});
// Image Creator toggle (cloud image generation): while on, the text you send is the image prompt.
let imageModeOn = false, brainLoading = !!(window.fidex && typeof window.fidex.chatWake === "function");
const WAIT_PH = "Wait for SpeedX to finish loading the brain...";
const idlePlaceholder = () => (brainLoading ? WAIT_PH : "Message FIDEX SI...");
if (window.fidex && typeof window.fidex.chatWake === "function") $("input").placeholder = WAIT_PH; // first start: tell the user to wait
const imgBtn = $("chat-imagegen");
imgBtn.addEventListener("click", () => {
  imageModeOn = !imageModeOn;
  imgBtn.classList.toggle("has-image", imageModeOn);
  imgBtn.setAttribute("aria-pressed", String(imageModeOn));
  $("input").placeholder = imageModeOn ? "Describe the image to create..." : idlePlaceholder();
  $("input").focus();
});
const chat = createChat({
  imageMode: { on: () => imageModeOn },
  attach,
  messagesEl: $("messages"),
  emptyEl: $("empty-state"),
  formEl: $("composer"),
  inputEl: $("input"),
  sendEl: $("send"),
  onSend: handleSend,
});

async function handleSend(text, image, genMode) {
  let conv = findActive();
  if (!conv) {
    conv = {
      id: newId(),
      title: makeTitle(text),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    conversations.unshift(conv);
    activeId = conv.id;
  }

  const userMsg = { id: newId(), role: "user", text, time: Date.now() };
  if (image) { userMsg.image = image.preview; userMsg.imageHash = image.hash; } // small copy; the findings are filled in after the answer
  conv.messages.push(userMsg);
  attachErrEl.hidden = true;
  conv.updatedAt = Date.now();

  // The Send button becomes Stop while the answer is written. Stop cancels the generation in the backend and
  // resolves at once, so Send is back immediately and a new message can be submitted.
  let userStopped = false, pending = null, frame = 0, persisted = false, timer = false, stoppedText = null;
  const persistOnce = () => { if (!persisted) { persisted = true; persistChats(); } };
  const onToken = (soFar) => { // real-time streaming: repaint at most once per frame
    if (!timer) { timer = true; setTimeout(persistOnce, 400); } // save the chats after the first token is on screen, never before it
    pending = soFar;
    if (frame || userStopped) return;
    frame = requestAnimationFrame(() => { frame = 0; if (!userStopped && pending !== null) chat.streamAnswer(pending); });
  };
  if (genMode) return runImageGen(conv, text);
  const replyPromise = getReply(conv, text, onToken, (stage) => { if (!userStopped && stage) chat.showStatus(stage); }, image); // the request leaves FIRST: the IPC call is made synchronously inside getReply
  refreshChat(); // DOM work (rebuilds the whole conversation + sidebar) runs only after the request is already on its way
  chat.showThinking();
  setTimeout(persistOnce, 1500); // fallback save if no token arrives
  const stopPromise = new Promise((resolve) => {
    chat.setGenerating(true, () => {
      stoppedText = pending; // what was already written at the moment Stop was pressed: it is kept
      userStopped = true;
      if (typeof replyPromise.stop === "function") replyPromise.stop();
      resolve({ stopped: true, text: "" });
    });
  });
  const reply = await Promise.race([replyPromise, stopPromise]);
  chat.setGenerating(false);
  const stopped = userStopped || reply.stopped;
  if (stopped) {
    chat.discardLive();
  } else {
    chat.showAnswer(reply.text); // final answer only
    await chat.finish(); // completes the glowing dot, then the saved message replaces the live card
  }
  if (image && !stopped && !reply.error) fetchFindings(image.hash).then((t) => { if (t) { userMsg.imageFindings = t; persistChats(); } }); // image context stays in the conversation (background, never blocks)
  const partial = stopped ? String(stoppedText != null ? stoppedText : pending || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim() : ""; // Stop keeps the half answer
  const aiMsg = { id: newId(), role: "assistant", text: stopped ? partial : reply.text, placeholder: !!reply.placeholder, time: Date.now() };
  if (!stopped && !reply.error && !reply.placeholder) aiMsg.card = true;
  if (stopped) { aiMsg.card = true; aiMsg.stopped = true; if (!partial) aiMsg.error = true; } // shown as: half answer + "....." + small grey "generation stopped"; the half answer stays in memory, an empty one does not
  else if (reply.error) aiMsg.error = true; // shown, but never fed back to the SI as memory
  conv.messages.push(aiMsg);
  conv.updatedAt = Date.now();
  persistChats();
  refreshChat(); // shows the reply if this conversation is still the open one
  history.render(conversations);
  if (!stopped && !reply.error && !reply.placeholder) afterReply(conv); // SpeedX: counts replies, refreshes the SI window every 4th
}

function refreshChat() {
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  const conv = findActive();
  $("chat-title").textContent = conv ? conv.title : "New chat";
  chat.render(conv);
  renderSidebarChats();
}

// ---------- Router ----------
const router = createRouter({
  rootEl: $("main"),
  onEnter: (name) => {
    sidebar.closePanel();
    if (name === "chat") refreshChat();
    else renderSidebarChats();
    if (name === "history") history.render(conversations);
    if (name === "about") about.load();
    if (name === "profile") profilePage.load();
  },
});

function navigate(route) {
  if (route === "chat-new") {
    activeId = null;
    router.go("chat");
    chat.focus();
    return;
  }
  router.go(route);
}

document.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("[data-route]") : null;
  if (target) navigate(target.dataset.route);
});

// Clicking the brand in the sidebar returns home.
for (const el of document.querySelectorAll(".brandbar .logo-tile, .brandbar .brand-text")) {
  el.classList.add("is-link");
  el.addEventListener("click", () => navigate("chat"));
}

// ---------- History ----------
const history = createHistory({
  els: {
    chatsList: $("history-chats"),
    empty: $("history-empty"),
    clearAll: $("history-clear-all"),
    startOver: $("history-start-over"),
  },
  onStartOver: async () => {
    if (!window.confirm("Start FIDEX from the beginning? ALL your data is erased (conversations, your details and everything FIDEX SI learned about you) and FIDEX SI will not know you anymore. This cannot be undone.")) return;
    conversations = [];
    persistChats();
    await bridge.backendRequest("memory.forget", { scope: "everything" });
    await bridge.backendRequest("app.reset-chat-cache", {});
    await resetProfile();
    try { localStorage.setItem("fidex.restart-onboarding", "1"); } catch (_) { /* ignore */ }
    location.reload(); // the first-time form appears again
  },
  onClearAll: async () => {
    if (!window.confirm("Delete all history? All conversations and what FIDEX SI learned from them are removed. Your saved details stay. This cannot be undone.")) return;
    conversations = [];
    activeId = null;
    persistChats();
    resetChatState();
    await bridge.backendRequest("memory.forget", { scope: "chat" }); // facts learned from chat messages (SQLite memory)
    await bridge.backendRequest("app.reset-chat-cache", {}); // cached image findings in the main process
    renderSidebarChats();
    refreshChat();
    history.render(conversations);
    toast("All conversations and chat memory were removed.");
  },
  onOpenChat: (id) => {
    activeId = id;
    router.go("chat");
    chat.focus();
  },
  onDeleteChat: (id) => {
    if (!window.confirm("Delete this conversation?")) return;
    conversations = conversations.filter((c) => c.id !== id);
    if (activeId === id) activeId = null;
    persistChats();
    bridge.backendRequest("app.reset-chat-cache", {}); // image/vision caches in the main process
    renderSidebarChats();
    history.render(conversations);
  },
});

// ---------- About ----------
const about = createAbout({ versionEl: $("about-version"), electronEl: $("about-electron"), chromeEl: $("about-chrome"), restartEl: $("about-restart") });

// ---------- Give Me Your Details ----------
const profilePage = createProfile({
  formEl: $("profile-form"),
  fieldsEl: { personal: $("profile-personal"), professional: $("profile-professional") },
  stateEl: $("profile-state"),
  clearEl: $("profile-clear"),
  toast,
});

// ---------- Title bar ----------
createTitlebar({
  minEl: $("win-min"),
  maxEl: $("win-max"),
  maxUseEl: $("win-max-use"),
  closeEl: $("win-close"),
  menuEl: $("menu-btn"),
  onMenu: () => sidebar.openPanel(),
});

// ---------- Welcome screen / workspace ----------
const views = createViews({
  welcomeEl: $("welcome-view"),
  workspaceEl: $("workspace-view"),
  onEnterWorkspace: () => {
    router.go("chat");
  },
});

// Boot order: the brain powers up FIRST. The voice (listen.js) and the ears (chat-mic.js) start only after the brain is ready.
// Wake the brain the moment the landing/opening page appears (it is also started by the main process at launch).
try {
  if (window.fidex && typeof window.fidex.chatWake === "function") {
    const bar = document.getElementById("brain-bar"), fill = document.getElementById("brain-bar-fill");
    const lab = document.getElementById("brain-bar-label"), pctEl = document.getElementById("brain-bar-pct");
    let expected = 8000;
    try { expected = Number(localStorage.getItem("fidex.brainLoadMs")) || 8000; } catch (_) { /* no storage */ }
    let startedAgo = 0, got = Date.now(), done = false, timerId = 0;
    const paint = (pct, text) => paintBar({ bar, fill, lab, pct: pctEl }, pct, text); // glides, never jumps
    const finish = (ok, ms) => {
      done = true; clearInterval(timerId);
      brainLoading = false; if (!imageModeOn) $("input").placeholder = "Message FIDEX SI...";
      if (ok) {
        paint(100, SPEEDX_LABEL); bar.classList.add("is-ready"); initSpeedX({ bar, fill, lab, pct: pctEl, btn: document.getElementById("speedx-btn"), getConv: () => findActive() }); hideBarLater(5000); // the SpeedX button appears only now
        try { if (ms > 500) localStorage.setItem("fidex.brainLoadMs", String(ms)); } catch (_) { /* no storage */ }
      } else { bar.classList.add("is-failed"); bar.hidden = false; reconnect(); }
    };
    // Real brain status + automatic reconnection: never a permanent "unavailable". Shows what is actually wrong, keeps retrying.
    let retrying = false;
    const describe = (st) => {
      if (!st) return "SpeedX: starting the AI engine...";
      if (st.state === "no_model" || st.model_installed === false) return "SpeedX: AI model not installed (put FIDEX-SI-Model-qwen3.5-4b.zip next to the app and restart)";
      if (st.state === "importing") return "SpeedX: installing the AI model...";
      if (st.state === "error") return "SpeedX: AI engine error - " + (st.error || "unknown");
      if (st.state === "ready" || st.reachable) return "SpeedX: loading the brain...";
      return "SpeedX: connecting to the AI engine...";
    };
    const reconnect = () => {
      if (retrying) return; retrying = true;
      if (typeof window.fidex.onBrainStatus === "function") window.fidex.onBrainStatus((st) => { if (retrying) paint(100, describe(st)); }); // live: "installing the AI model..." while the ZIP is imported
      const loop = async () => {
        let st = null;
        try { st = typeof window.fidex.brainStatus === "function" ? await window.fidex.brainStatus() : null; } catch (_) { /* main not ready */ }
        let ok = false;
        try { const w = await window.fidex.chatWake(); ok = !!(w && w.ok); } catch (_) { /* retry */ }
        if (ok) { retrying = false; bar.classList.remove("is-failed"); finish(true, 0); return; }
        bar.classList.add("is-failed"); paint(100, describe(st));
        setTimeout(loop, 4000);
      };
      loop();
    };
    const tick = () => { // estimated progress: climbs toward 95% by the last known load time, never claims 100% before the brain is truly ready
      if (done) return;
      const el = startedAgo + (Date.now() - got), f = el / expected;
      paint(Math.min(95, f < 1 ? f * 90 : 90 + 5 * (1 - 1 / f)), SPEEDX_LABEL);
    };
    window.fidex.chatWake().then((r) => { startedAgo = (r && r.sinceStart) || 0; finish(!!(r && r.ok), (r && r.totalMs) || startedAgo); }).catch(() => finish(false, 0));
    timerId = setInterval(tick, 200); tick();
  }
} catch (_) { /* browser preview */ }

// First launch only: typewriter intro + onboarding, then the normal welcome screen. Later launches go straight on.
initProfile().then(() => {
  let force = false;
  try { force = localStorage.getItem("fidex.restart-onboarding") === "1"; localStorage.removeItem("fidex.restart-onboarding"); } catch (_) { /* ignore */ }
  runFirstRun({ onDone: () => views.showWelcome(), force });
});
renderSidebarChats(); // saved chats from the last session appear straight away

// ---------- Python backend (Step 4) ----------
// Silent communication check: sends "Hello from FIDEX AI" to Python and logs the reply in the
// developer console. It changes nothing on screen. The AI brain is not connected.
checkBackendConnection();

// Image Creator: Python backend -> Cloudflare Workers AI (FLUX.1 schnell). The API token never reaches the window.
async function runImageGen(conv, prompt) {
  refreshChat();
  chat.showGenLoading(); // animation only, no text
  chat.setGenerating(true, null);
  const res = await bridge.backendRequest("image.generate", { prompt });
  chat.setGenerating(false);
  chat.discardLive();
  const aiMsg = { id: newId(), role: "assistant", text: "", time: Date.now() };
  if (res.ok && res.data && res.data.image) {
    aiMsg.text = "Here is your image.";
    aiMsg.genImage = "data:" + (res.data.mime || "image/jpeg") + ";base64," + res.data.image;
    aiMsg.genPrompt = prompt;
  } else {
    aiMsg.text = "Image generation failed: " + ((res.error && res.error.message) || "unknown error");
    aiMsg.error = true;
  }
  conv.messages.push(aiMsg);
  conv.updatedAt = Date.now();
  persistChats();
  refreshChat();
  history.render(conversations);
}
