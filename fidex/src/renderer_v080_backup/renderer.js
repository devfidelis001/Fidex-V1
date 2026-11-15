"use strict";

// Entry point of the interface. It creates each module and wires them together.
// Feature code lives in js/; this file only connects the pieces.

import { loadConversations, saveConversations, loadCommands, saveCommands, loadSettings, saveSettings, newId } from "./js/storage.js";
import { getReply } from "./js/responder.js";
import { createChat } from "./js/chat.js";
import { createSidebar } from "./js/sidebar.js";
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
      title: text.length > 40 ? text.slice(0, 40) + "..." : text,
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

  const reply = await getReply(conv, text);
  conv.messages.push({ id: newId(), role: "assistant", text: reply.text, placeholder: !!reply.placeholder, time: Date.now() });
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
}

// ---------- Router ----------
const router = createRouter({
  rootEl: $("main"),
  onEnter: (name) => {
    sidebar.closePanel();
    if (name === "chat") refreshChat();
    if (name === "history") history.render(conversations, commands);
    if (name === "settings") settings.refresh(conversations.length, commands.length);
    if (name === "about") about.load();
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
    toast("Assignment saved (preview). The Take Over panel is switched off in Settings.");
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
  examplesEl: $("takeover-examples"),
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
  resultEl: $("world-result"),
  resultTextEl: $("world-result-text"),
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
    settings.refresh(conversations.length, commands.length);
  },
  onClearCommands: () => {
    commands = [];
    persistCommands();
    settings.refresh(conversations.length, commands.length);
  },
  onShowWelcome: () => views.showWelcome(),
});

const about = createAbout({ versionEl: $("about-version"), electronEl: $("about-electron"), chromeEl: $("about-chrome") });

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

views.showWelcome();

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
