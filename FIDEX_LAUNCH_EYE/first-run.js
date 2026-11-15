// First launch only: 7-second unboxing intro, then a small optional onboarding form.
// A flag in localStorage records that it has been shown, so it never appears again.
// The 3D intro module is loaded on demand, so normal launches pay nothing for it.

import { loadProfile, saveProfile } from "./storage.js";
import { cleanProfile, syncToBrain } from "./profile.js";

// Bumped to v2 so the redesigned intro plays once for everyone who only saw the old one.
const FLAG_KEY = "fidex.firstrun.v2";

function isDone() {
  try {
    return !!localStorage.getItem(FLAG_KEY);
  } catch (err) {
    return false;
  }
}

function markDone(info) {
  try {
    localStorage.setItem(FLAG_KEY, JSON.stringify({ done: true, at: new Date().toISOString(), ...info }));
  } catch (err) {
    // Storage unavailable: the intro may show again next launch, nothing else breaks.
  }
}

export function runFirstRun({ onDone, force = false }) {
  if (!force && isDone()) {
    onDone();
    return;
  }

  const $ = (id) => document.getElementById(id);
  const introEl = $("intro-view");
  const onboardEl = $("onboard-view");
  const formEl = $("onboard-form");
  let introEnded = false;
  let finished = false;
  let stopIntro = null;

  function finish(info) {
    if (finished) return;
    finished = true;
    markDone(info);
    onboardEl.classList.remove("show");
    onboardEl.classList.add("fade-out");
    setTimeout(() => {
      onboardEl.hidden = true;
      onDone();
    }, 400);
  }

  function showOnboarding() {
    if (introEnded) return;
    introEnded = true;
    if (stopIntro) stopIntro();
    onboardEl.hidden = false;
    requestAnimationFrame(() => {
      onboardEl.classList.add("show");
      introEl.classList.add("fade-out");
      setTimeout(() => {
        introEl.hidden = true;
      }, 650);
      $("ob-name").focus({ preventScroll: true });
    });
  }

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const existing = loadProfile();
    const entered = cleanProfile({
      name: $("ob-name").value,
      role: $("ob-role").value,
      goals: $("ob-project").value,
      about: $("ob-other").value,
    });
    if (Object.keys(entered).length) {
      const profile = { ...existing, ...entered };
      saveProfile(profile);
      syncToBrain(profile).catch(() => {}); // mirror into FIDEX memory; local copy is already saved
    }
    finish({ skipped: false });
  });
  $("ob-skip").addEventListener("click", () => finish({ skipped: true }));

  // Play the intro. If anything fails, go straight to the form.
  introEl.hidden = false;
  $("intro-skip").addEventListener("click", showOnboarding);
  import("./intro-3d.js")
    .then((m) => {
      if (introEnded) return;
      stopIntro = m.playIntro({
        canvas: $("intro-canvas"),
        titleEl: $("intro-title"),
        duration: 7000,
        onEnd: showOnboarding,
      });
    })
    .catch(showOnboarding);
}

// Settings > Interface > "Replay intro animation": plays the intro and form again without touching the saved flag.
const replayBtn = document.getElementById("replay-intro");
if (replayBtn) {
  replayBtn.addEventListener("click", () => {
    const form = document.getElementById("onboard-form");
    form.reset();
    document.getElementById("onboard-view").classList.remove("show", "fade-out");
    document.getElementById("intro-view").classList.remove("fade-out");
    document.getElementById("intro-title").classList.remove("on", "off");
    runFirstRun({ onDone: () => {}, force: true });
  });
}
