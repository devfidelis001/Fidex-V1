// First launch: typewriter introduction, then the onboarding form. Everything is saved in the
// local SQLite database (through storage.js) and read by the Brain on every message.

import { loadProfile, saveProfile } from "./storage.js";
import { cleanProfile } from "./profile.js";

const LINES = [
  "I'm FIDEX AI, your F-Bot.",
  "I can be your CEO, worker, manager, co-founder \u2014 whatever you want me to be.",
  "Would you mind sharing some information with me so we can work together?",
];

let runId = 0;

export function runFirstRun({ onDone, force = false }) {
  if (!force && loadProfile()._onboarded) {
    onDone();
    return;
  }
  const $ = (id) => document.getElementById(id);
  const view = $("fr-view");
  const typeEl = $("fr-type");
  const form = $("onboard-form");
  let finished = false;
  const myRun = ++runId;
  const isCancelled = () => myRun !== runId || finished;

  function finish(save) {
    if (finished) return;
    finished = true;
    const existing = loadProfile();
    let next = { ...existing, _onboarded: "1" };
    if (save) {
      const picked = form.querySelector('input[name="ob-convo"]:checked');
      const entered = cleanProfile({
        name: $("ob-name").value,
        role: $("ob-role").value,
        tools: $("ob-tools").value,
        about: $("ob-about").value,
        goals: $("ob-project").value,
        convoMgmt: picked ? picked.value : "", // only "yes" when the user explicitly chose it
      });
      next = { ...next, ...entered };
    }
    saveProfile(next);
    view.classList.add("fade-out");
    setTimeout(() => {
      view.hidden = true;
      view.classList.remove("fade-out");
      onDone();
    }, 450);
  }

  function showForm() {
    form.hidden = false;
    requestAnimationFrame(() => form.classList.add("show"));
    $("ob-name").focus({ preventScroll: true });
  }

  async function type() {
    typeEl.textContent = "";
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const line of LINES) {
      const p = document.createElement("span");
      p.className = "fr-line";
      typeEl.appendChild(p);
      for (const ch of line) {
        if (isCancelled()) return;
        p.textContent += ch;
        if (!reduce) await wait(/[,.\u2014?]/.test(ch) ? 140 : 32);
      }
      if (!reduce) await wait(450);
    }
    if (!isCancelled()) showForm();
  }

  form.reset();
  form.hidden = true;
  form.classList.remove("show");
  view.hidden = false;
  form.onsubmit = (e) => {
    e.preventDefault();
    finish(true);
  };
  $("ob-skip-form").onclick = () => finish(false);
  $("fr-skip").onclick = () => finish(false);
  type();
}

// Settings > Interface > "See start": shows the full new landing (typewriter intro + form) again from the beginning.
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("#replay-intro")) runFirstRun({ onDone: () => {}, force: true });
});
