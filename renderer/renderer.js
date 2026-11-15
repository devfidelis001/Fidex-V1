"use strict";

// Entry point of the interface. It creates each module and wires them together.
// Feature code lives in js/; this file only connects the pieces.

import { loadConversations, saveConversations, loadCommands, saveCommands, loadSettings, saveSettings, newId, makeTitle } from "./js/storage.js";
import { getReply } from "./js/responder.js";
import { createChat } from "./js/chat.js";
import { createSidebar, renderRecentChats } from "./js/sidebar.js";
import { createRouter } from "./js/router.js";
import { createViews } from "./js/views.js";
import { createToast } from "./js/toast.js";
import { createTitlebar } from "./js/titlebar.js";
import { createCommandBox } from "./js/commandbox.js";
import { createTakeOver, renderRecentList } from "./js/takeover.js";
import { bridge } from "./js/bridge.js";
import { createWorld } from "./js/world.js";
import { createHistory } from "./js/history.js";
import { createSettings } from "./js/settings.js";
import { createAbout } from "./js/about.js";
import { checkBackendConnection } from "./js/backend-link.js";
import { markUnfinished } from "./js/resume.js";
import { createProfile } from "./js/profile.js";
import { createPermissions } from "./js/permissions.js";
import { createGuide } from "./js/guide.js";
import { runFirstRun } from "./js/first-run.js";
import { initProfile } from "./js/storage.js";
import { createVisionControls } from "./js/vision-panel.js";

const $ = (id) => document.getElementById(id);
const q = (sel, root = document) => root.querySelector(sel);

let conversations = loadConversations(); // newest first
let commands = loadCommands(); // newest first
let settingsState = loadSettings();
let activeId = null; // null = a new chat that has no messages yet

const findActive = () => conversations.find((c) => c.id === activeId) || null;
const persistChats = () => saveConversations(conversations);
const persistCommands = () => saveCommands(commands);

const toast = createToast($("toast"));
const voiceSoon = () => toast("Voice commands are not available yet. They arrive in a later phase.");

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
const chat = createChat({
  messagesEl: $("messages"),
  emptyEl: $("empty-state"),
  formEl: $("composer"),
  inputEl: $("input"),
  sendEl: $("send"),
  onSend: handleSend,
});

async function handleSend(text) {
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

  conv.messages.push({ id: newId(), role: "user", text, time: Date.now() });
  conv.updatedAt = Date.now();
  persistChats();
  refreshChat();
  chat.showThinking();

  // The Send button becomes Stop while the answer is written. Stop cancels the generation in the backend and
  // resolves at once, so Send is back immediately and a new message can be submitted.
  let userStopped = false, pending = null, frame = 0;
  const onToken = (soFar) => { // real-time streaming: repaint at most once per frame
    pending = soFar;
    if (frame || userStopped) return;
    frame = requestAnimationFrame(() => { frame = 0; if (!userStopped && pending !== null) chat.streamAnswer(pending); });
  };
  const replyPromise = getReply(conv, text, onToken);
  const stopPromise = new Promise((resolve) => {
    chat.setGenerating(true, () => {
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
  const aiMsg = { id: newId(), role: "assistant", text: stopped ? "Generation stopped." : reply.text, placeholder: !!reply.placeholder, time: Date.now() };
  if (!stopped && !reply.error && !reply.placeholder) aiMsg.card = true;
  if (reply.error || stopped) aiMsg.error = true; // shown, but never fed back to the AI as memory
  conv.messages.push(aiMsg);
  conv.updatedAt = Date.now();
  persistChats();
  refreshChat(); // shows the reply if this conversation is still the open one
  history.render(conversations, commands);
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
    if (name === "history") history.render(conversations, commands);
    if (name === "settings") settings.refresh(conversations.length, commands.length);
    if (name === "about") about.load();
    if (name === "profile") profilePage.load();
    if (name === "permissions") permissionsPage.load();
    if (name === "guide") guide.load();
    if (name === "takeover" || name === "home") refreshRecent();
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
  if (route === "takeover") takeover.focus();
}

document.addEventListener("click", (e) => {
  const target = e.target instanceof Element ? e.target.closest("[data-route]") : null;
  if (target) navigate(target.dataset.route);
});

// Clicking the brand in the sidebar returns home.
for (const el of document.querySelectorAll(".brandbar .logo-tile, .brandbar .brand-text")) {
  el.classList.add("is-link");
  el.addEventListener("click", () => navigate("home"));
}

// ---------- Assign work: submit -> Take Over window (logo circle + activity panel) ----------
const homeRecentEl = $("home-recent");
const homeRecentEmptyEl = $("home-recent-empty");
const pickRecent = (text, cmd) => {
  // An assignment whose progress was saved before FIDEX AI closed continues where it stopped.
  if (cmd && cmd.status === "interrupted" && bridge.inElectron && settingsState.autoCompact) {
    bridge.openOverlay({ id: cmd.id, text: cmd.text, resume: true }, { alwaysOnTop: settingsState.compactOnTop });
    return;
  }
  router.go("takeover");
  takeover.setValue(text);
  takeover.focus();
};
const refreshRecent = () => {
  takeover.renderRecent(commands);
  renderRecentList(homeRecentEl, homeRecentEmptyEl, commands, pickRecent);
};

function submitTakeOver(text) {
  const command = { id: newId(), text, time: Date.now(), source: "text", status: "assigned" };
  commands.unshift(command);
  persistCommands();
  refreshRecent();
  history.render(conversations, commands);

  if (!settingsState.autoCompact) {
    toast("Assignment saved. The Take Over panel is switched off in Settings.");
  } else if (!bridge.inElectron) {
    toast("Assignment saved. The Take Over circle and panel open in the desktop app.");
  } else {
    bridge.openOverlay({ id: command.id, text }, { alwaysOnTop: settingsState.compactOnTop });
  }
}

// The Take Over panel reports its progress; keep it with the assignment so History shows the outcome.
bridge.onOverlayEvent((update) => {
  const cmd = commands.find((c) => c.id === update.id);
  if (!cmd) return;
  cmd.status = update.status;
  cmd.stage = update.stage;
  cmd.outstanding = update.outstanding || [];
  persistCommands();
  refreshRecent();
  history.render(conversations, commands);
});

const takeover = createTakeOver({
  formEl: $("takeover-form"),
  inputEl: $("takeover-input"),
  sendEl: $("takeover-send"),
  micEl: $("takeover-mic"),
  recentEl: $("takeover-recent"),
  recentEmptyEl: $("takeover-recent-empty"),
  onSubmit: submitTakeOver,
  onMic: voiceSoon,
  onPickRecent: pickRecent,
});

// Home: the central project input
const homeCmd = createCommandBox({
  formEl: $("home-cmd"),
  inputEl: $("home-input"),
  sendEl: q(".cmd-send", $("home-cmd")),
  onSubmit: submitTakeOver,
});

// ---------- World Problems ----------
createWorld({
  formEl: $("world-form"),
  topicEl: $("world-topic"),
  areasEl: $("world-areas"),
  stateEl: $("world-state"),
  startEl: $("world-start"),
  stopEl: $("world-stop"),
  runEl: $("world-run"),
  toast,
});

// ---------- History ----------
const history = createHistory({
  els: {
    chatsTab: $("tab-chats"),
    commandsTab: $("tab-commands"),
    countChats: $("count-chats"),
    countCommands: $("count-commands"),
    chatsList: $("history-chats"),
    commandsList: $("history-commands"),
    empty: $("history-empty"),
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
    renderSidebarChats();
    history.render(conversations, commands);
  },
  onOpenCommand: pickRecent,
  onDeleteCommand: (id) => {
    commands = commands.filter((c) => c.id !== id);
    persistCommands();
    history.render(conversations, commands);
  },
});

// ---------- Settings / About ----------
const settings = createSettings({
  els: {
    autoCompact: $("set-auto-compact"),
    onTop: $("set-on-top"),
    count: $("stored-count"),
    clearChats: $("clear-all"),
    clearCommands: $("clear-commands"),
    showWelcome: $("show-welcome"),
  },
  getSettings: () => settingsState,
  onChange: (patch) => {
    settingsState = { ...settingsState, ...patch };
    saveSettings(settingsState);
  },
  onClearChats: () => {
    conversations = [];
    activeId = null;
    persistChats();
    renderSidebarChats();
    settings.refresh(conversations.length, commands.length);
  },
  onClearCommands: () => {
    commands = [];
    persistCommands();
    settings.refresh(conversations.length, commands.length);
  },
  onShowWelcome: () => views.showWelcome(),
});

const about = createAbout({ versionEl: $("about-version"), electronEl: $("about-electron"), chromeEl: $("about-chrome"), developerEl: $("about-developer") });

// ---------- v0.9.0: Give Me Your Details / Permissions / Guide Me ----------
const profilePage = createProfile({
  formEl: $("profile-form"),
  fieldsEl: { personal: $("profile-personal"), professional: $("profile-professional") },
  stateEl: $("profile-state"),
  clearEl: $("profile-clear"),
  toast,
});
createVisionControls({ statusEl: $("vision-status"), textEl: $("vision-text") });
const permissionsPage = createPermissions({ listEl: $("permissions-list"), resetEl: $("permissions-reset"), toast });
const guide = createGuide({
  toast,
  els: {
    form: $("guide-form"), goal: $("guide-goal"), stepsInput: $("guide-steps-input"),
    plan: $("guide-plan"), planTitle: $("guide-plan-title"), close: $("guide-plan-close"),
    bar: $("guide-bar"), pct: $("guide-pct"), next: $("guide-next"), steps: $("guide-steps"),
    addForm: $("guide-add-form"), addInput: $("guide-add-input"),
    list: $("guide-list"), empty: $("guide-empty"),
    resume: $("guide-resume"), resumeText: $("guide-resume-text"), resumeBtn: $("guide-resume-btn"),
  },
});
guide.restoreFromBackend();

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
    router.go("home");
  },
});

// First launch only: typewriter intro + onboarding, then the normal welcome screen. Later launches go straight on.
initProfile().then(() => runFirstRun({ onDone: () => views.showWelcome() }));
renderSidebarChats(); // saved chats from the last session appear straight away

// ---------- Python backend (Step 4) ----------
// Silent communication check: sends "Hello from FIDEX AI" to Python and logs the reply in the
// developer console. It changes nothing on screen. The AI brain is not connected.
checkBackendConnection();

// ---------- Automatic save progress (Step 6) ----------
// On start, ask the backend which tasks were saved but never finished. They show up in the recent
// assignments / History as "Interrupted: click to continue". Nothing restarts by itself.
markUnfinished(commands).then((found) => {
  if (!found || !found.changed) return;
  persistCommands();
  refreshRecent();
  history.render(conversations, commands);
  if (found.restored) toast(`${found.restored === 1 ? "1 unfinished task was" : found.restored + " unfinished tasks were"} saved. Open it from your recent assignments to continue.`);
});
