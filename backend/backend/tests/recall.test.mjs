// Run: node --test tests/recall.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { wantsPastChats, recallPastChats, wantsContinue, MAX_RECALL_CHARS } from "../src/renderer/js/recall.js";

const NOW = new Date("2026-11-04T12:00:00").getTime();
const DAY = 86400000;
const m = (role, text) => ({ id: Math.random().toString(), role, text, time: 1 });
const convs = [
  { id: "a", title: "Bakery website plan", updatedAt: NOW - DAY, messages: [m("user", "Let's plan a website for my bakery"), m("assistant", "We decided on a one-page site with an online order form and the colour cream and brown.")] },
  { id: "b", title: "Capital cities", updatedAt: NOW - 5 * DAY, messages: [m("user", "What is the capital of France?"), m("assistant", "Paris.")] },
  { id: "c", title: "Logo ideas", updatedAt: NOW - 2 * 3600000, messages: [m("user", "Which logo style should I pick for the app?"), m("assistant", "Pick the kite icon with a thin outline."), m("user", "ok"), m("assistant", "Good, let's keep the kite.")] },
  { id: "cur", title: "Current", updatedAt: NOW, messages: [m("user", "bakery secret current chat"), m("assistant", "x")] },
];

test("ordinary messages never trigger a search", () => {
  for (const t of ["Hello", "hi there", "How do I bake bread?", "What is the capital of Nigeria?", "What is a decision tree?", "Write a poem about the sea", "Explain previous versions of Windows", "Tell me about the last supper", "What did Napoleon decide?", "Can you help me plan a website?", "Good morning, how are you?", "I need a logo for my app", "/memory"]) {
    assert.equal(wantsPastChats(t), false, t);
  }
});

test("questions about earlier chats, questions and decisions trigger a search", () => {
  for (const t of [
    "What did we decide about the bakery website?",
    "What did I ask you yesterday?",
    "Remind me what we talked about earlier",
    "Continue where we left off",
    "Can we continue our previous conversation about the logo?",
    "Did we discuss pricing before?",
    "In our last chat you said I should use the kite icon",
    "As we discussed, the site stays one page",
    "What was the decision we made on the logo?",
    "You told me something about colours yesterday",
    "Go back to our conversation about the bakery",
    "What did you recommend last time?",
  ]) {
    assert.equal(wantsPastChats(t), true, t);
  }
});

test("retrieves the relevant past messages and excludes the open chat", () => {
  const out = recallPastChats(convs, "What did we decide about the bakery website?", "cur", NOW);
  assert.match(out, /one-page site/);
  assert.match(out, /Bakery website plan/);
  assert.doesNotMatch(out, /secret current chat/);
  assert.doesNotMatch(out, /Paris/);
});

test("picks the right chat among several", () => {
  const out = recallPastChats(convs, "which logo did we choose earlier", "cur", NOW);
  assert.match(out, /kite/);
  assert.doesNotMatch(out, /bakery/i);
});

test("time words narrow the search, with a fallback", () => {
  assert.match(recallPastChats(convs, "What did we talk about yesterday?", "cur", NOW), /bakery/i);
  assert.match(recallPastChats(convs, "what did we say about Paris last week", "cur", NOW), /Paris/);
});

test("continue returns the end of the matching chat in order", () => {
  assert.equal(wantsContinue("continue where we left off on the logo"), true);
  const out = recallPastChats(convs, "continue where we left off on the logo", "cur", NOW);
  assert.ok(out.indexOf("Which logo style") < out.indexOf("keep the kite"));
});

test("says so honestly when nothing matches, or there are no chats", () => {
  assert.match(recallPastChats(convs, "what did we decide about the rocket engine?", "cur", NOW), /could not find/);
  assert.match(recallPastChats([], "what did we discuss?", null, NOW), /No earlier conversations/);
});

test("ignores placeholder/error messages and stays within the size limit", () => {
  const big = [{ id: "z", title: "Long", updatedAt: NOW - DAY, messages: [m("user", "budget plan " + "x".repeat(5000)), { ...m("assistant", "budget placeholder"), placeholder: true }, m("assistant", "budget " + "y".repeat(5000))] }];
  const out = recallPastChats(big, "what did we say about the budget", null, NOW);
  assert.ok(out.length <= MAX_RECALL_CHARS + 50, String(out.length));
  assert.doesNotMatch(out, /placeholder/);
});
