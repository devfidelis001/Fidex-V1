// Start Solving World Problems: Research & Problem Solving.
// The user describes a problem, picks a focus (Jobs, Advertisement, Any Problem) and clicks Start research.
// The Python backend then runs a real research workflow (AI planning, web search, reading pages, extracting
// findings, iterating on gaps, analysis). Every step it takes arrives as a "research.event" snapshot and is
// drawn here as a progress card: done, active or pending. Nothing on this page is predefined or simulated;
// outside the desktop app (no backend) it says that research cannot run and does not show any progress.
// "Approve & Start Building" is a placeholder for the future building phase. It never starts anything.

import { bridge } from "./bridge.js";
import { loadResearch, saveResearch } from "./storage.js";

const AREAS = [
  { id: "health", label: "Health" },
  { id: "climate", label: "Climate" },
  { id: "education", label: "Education" },
  { id: "energy", label: "Energy" },
  { id: "water", label: "Water and food" },
  { id: "economy", label: "Economy" },
  { id: "jobs", label: "Jobs" },
  { id: "advertisement", label: "Advertisement" },
  { id: "any", label: "Others" },
];
const STATE_LABEL = { done: "Done", active: "In progress", pending: "Waiting", failed: "Failed", skipped: "Skipped" };
const KIND_LABEL = { plan: "Plan", search: "Search", read: "Read", extract: "Findings", review: "Review", analyse: "Analyse", solutions: "Solutions", recommend: "Recommend" };
const RUN_LABEL = { running: "Researching", done: "Research complete", failed: "Research could not finish", cancelled: "Research stopped" };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // text only, never HTML
  return n;
};
const fmtSecs = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

export function createWorld({ formEl, topicEl, areasEl, stateEl, startEl, stopEl, runEl, toast }) {
  let selected = "any";
  let runId = null;
  let snap = null;
  let starting = false;
  let poll = null;
  let ticker = null;
  const early = new Map(); // snapshots that arrive before research.start has answered

  const hint = (t) => { stateEl.textContent = t; };

  // ---------- focus chips ----------
  for (const area of AREAS) {
    const chip = el("button", "chip", area.label);
    chip.type = "button";
    chip.dataset.area = area.id;
    chip.addEventListener("click", () => {
      if (runId && snap && snap.status === "running") return;
      selected = area.id;
      syncChips();
    });
    areasEl.appendChild(chip);
  }
  function syncChips() {
    for (const c of areasEl.children) {
      const on = c.dataset.area === selected;
      c.classList.toggle("selected", on);
      c.setAttribute("aria-pressed", String(on));
    }
  }
  syncChips();

  // ---------- rendering ----------
  function activityCard(a) {
    const card = el("li", `rc rc-${a.state}`);
    const icon = el("span", "rc-icon");
    icon.setAttribute("aria-hidden", "true");
    const body = el("div", "rc-body");
    const head = el("div", "rc-head");
    head.append(el("span", "rc-kind", KIND_LABEL[a.kind] || a.kind), el("span", "rc-state", STATE_LABEL[a.state] || a.state));
    body.append(head, el("b", "rc-title", a.title));
    if (a.detail) body.append(el("span", "rc-detail", a.detail));
    if (a.result) body.append(el("span", "rc-result", a.result));
    card.append(icon, body);
    card.setAttribute("aria-label", `${a.title}: ${STATE_LABEL[a.state] || a.state}`);
    return card;
  }

  function section(title, note) {
    const s = el("section", "rs-section");
    s.append(el("h4", "label", title));
    if (note) s.append(el("p", "muted small rs-note", note));
    return s;
  }

  const cite = (nums) => (nums && nums.length ? el("span", "rs-cite", nums.map((n) => `[${n}]`).join(" ")) : null);

  function copyButton(url) {
    const b = el("button", "btn btn-outline btn-sm", "Copy link");
    b.type = "button";
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast("Link copied.");
      } catch (err) {
        toast(url, 6000);
      }
    });
    return b;
  }

  function reportView(s) {
    const r = s.report;
    const frag = document.createDocumentFragment();
    const webBased = s.sources.some((x) => x.read);
    if (!webBased) {
      frag.append(el("div", "rs-warn", "No web sources were read, so nothing below is backed by evidence."));
    }
    if (r && r.summary) {
      const sec = section("Summary");
      sec.append(el("p", "rs-text", r.summary));
      frag.append(sec);
    }

    if (s.findings.length) {
      const sec = section("Findings and evidence", "Each finding comes from a page that was read. A quote is shown only when it was found word for word on that page.");
      const ul = el("ul", "rs-list");
      for (const f of s.findings) {
        const li = el("li", "rs-item");
        li.append(el("span", "rs-text", f.text), cite([f.source]));
        if (f.verified && f.quote) li.append(el("blockquote", "rs-quote", `“${f.quote}”`));
        else li.append(el("span", "rs-tag", "No exact quote verified"));
        ul.append(li);
      }
      sec.append(ul);
      frag.append(sec);
    }

    if (r && r.causes.length) {
      const sec = section("Causes");
      for (const c of r.causes) {
        const box = el("div", "rs-card");
        box.append(el("b", "", c.cause));
        if (c.explanation) box.append(el("p", "rs-text", c.explanation));
        const ci = cite(c.sources);
        if (ci) box.append(ci);
        sec.append(box);
      }
      frag.append(sec);
    }

    if (r && r.solutions.length) {
      const sec = section("Solution comparison");
      const grid = el("div", "rs-grid");
      for (const o of r.solutions) {
        const box = el("div", "rs-card");
        box.append(el("b", "", o.name), el("p", "rs-text", o.description));
        const tags = el("div", "rs-tags");
        tags.append(el("span", "rs-tag", `Effort: ${o.effort}`), el("span", "rs-tag", `Impact: ${o.impact}`));
        box.append(tags);
        for (const [label, list] of [["Pros", o.pros], ["Cons", o.cons]]) {
          if (!list.length) continue;
          const p = el("p", "rs-text rs-pc");
          p.append(el("b", "", label + ": "), document.createTextNode(list.join("; ")));
          box.append(p);
        }
        const ci = cite(o.sources);
        if (ci) box.append(ci);
        grid.append(box);
      }
      sec.append(grid);
      frag.append(sec);
    }

    if (r && r.recommendation) {
      const sec = section("Recommendation");
      const box = el("div", "rs-card rs-reco");
      box.append(el("b", "", r.recommendation.choice), el("p", "rs-text", r.recommendation.why));
      const ci = cite(r.recommendation.sources);
      if (ci) box.append(ci);
      sec.append(box);
      frag.append(sec);
    }

    if (r && r.plan.length) {
      const sec = section("Implementation plan");
      const ol = el("ol", "rs-plan");
      for (const st of r.plan) {
        const li = el("li");
        li.append(el("b", "", st.step));
        if (st.detail) li.append(el("span", "rs-text", st.detail));
        ol.append(li);
      }
      sec.append(ol);
      frag.append(sec);
    }

    const read = s.sources.filter((x) => x.read);
    if (read.length) {
      const sec = section("Resources", "The pages this research actually read.");
      const ul = el("ul", "rs-list");
      for (const src of read) {
        const li = el("li", "rs-item rs-src");
        const info = el("div", "rs-srcinfo");
        info.append(el("b", "", `[${src.n}] ${src.title}`), el("span", "rs-url", src.url));
        li.append(info, copyButton(src.url));
        ul.append(li);
      }
      sec.append(ul);
      frag.append(sec);
    }
    return frag;
  }

  function render() {
    noteForm.hidden = !(snap && (snap.status === "running" || snap.status === "done"));
    runEl.replaceChildren();
    if (!snap) {
      runEl.hidden = true;
      return;
    }
    runEl.hidden = false;
    const s = snap;
    const counts = { done: 0, active: 0, pending: 0, failed: 0 };
    for (const a of s.activities) if (counts[a.state] !== undefined) counts[a.state]++;

    const head = el("div", "rs-head");
    const title = el("div");
    title.append(el("h3", "rs-title", RUN_LABEL[s.status] || "Research"));
    const sub = el("p", "muted small rs-sub");
    sub.id = "rs-sub";
    title.append(sub);
    head.append(title, el("span", `rs-pill rs-pill-${s.status}`, s.status === "running" ? "Live" : s.status === "done" ? "Complete" : s.status === "cancelled" ? "Stopped" : "Stopped with errors"));
    runEl.append(head);
    updateSub();

    for (const n of s.notes) runEl.append(el("div", "rs-warn", n));
    if (s.error && s.status === "failed") runEl.append(el("div", "rs-warn", s.error));

    const prog = section("Research progress");
    const legend = el("p", "rs-legend muted small", `${counts.done} done · ${counts.active} in progress · ${counts.pending} waiting` + (counts.failed ? ` · ${counts.failed} failed` : ""));
    prog.append(legend);
    const list = el("ol", "rs-activities");
    list.setAttribute("aria-live", "polite");
    for (const a of s.activities) list.append(activityCard(a));
    if (!s.activities.length) list.append(el("li", "muted small", "Starting..."));
    prog.append(list);
    runEl.append(prog);

    if (s.status === "running" && s.findings.length) { // discoveries appear while the research is still going
      const sec = section("Discoveries so far");
      const ul = el("ul", "rs-list");
      for (const f of s.findings.slice(-6)) {
        const li = el("li", "rs-item");
        li.append(el("span", "rs-text", f.text), cite([f.source]));
        ul.append(li);
      }
      sec.append(ul);
      runEl.append(sec);
    }

    if (s.status !== "running") {
      runEl.append(reportView(s));
      if (s.status === "done") {
        const bar = el("div", "rs-approve");
        const b = s.build;
        if (!b && !askBuild) {
          const btn = el("button", "btn btn-dark", "Start solving real life problem");
          btn.type = "button";
          btn.id = "world-approve";
          btn.addEventListener("click", () => { askBuild = true; render(); });
          bar.append(btn);
        } else if (!b) {
          const yes = el("button", "btn btn-dark", "Yes, start solving");
          yes.type = "button";
          yes.addEventListener("click", () => { askBuild = false; startSolving(s); render(); });
          const no = el("button", "btn btn-outline", "Not now");
          no.type = "button";
          no.addEventListener("click", () => { askBuild = false; render(); });
          bar.append(el("span", "small", "Research is done. Allow FIDEX AI to take over, create a new folder, open it in VS Code and start solving this problem?"), yes, no);
        } else if (b.status === "running") {
          const stop = el("button", "btn btn-outline", "Stop building");
          stop.type = "button";
          stop.addEventListener("click", async () => {
            await bridge.backendRequest("research.build_stop", { run_id: s.run_id });
            s.build = { status: "failed", error: "Building stopped by you." };
            render();
          });
          bar.append(el("span", "muted small", "Writing the website code..."), stop);
        } else if (b.status === "failed") {
          const retry = el("button", "btn btn-dark", "Try again");
          retry.type = "button";
          retry.addEventListener("click", async () => {
            const res = await bridge.backendRequest("research.build", { run_id: s.run_id });
            if (res.ok) { s.build = { status: "running" }; render(); poll2(s.run_id); }
            else toast((res.error && res.error.message) || "Could not start building.");
          });
          bar.append(el("span", "small", b.error || "Building failed."), retry);
        } else {
          const dl = el("button", "btn btn-outline", "Download website");
          dl.type = "button";
          dl.addEventListener("click", () => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([b.html], { type: "text/html" }));
            a.download = "fidex-solution.html";
            a.click();
          });
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-scripts");
          frame.srcdoc = b.html;
          frame.style.cssText = "width:100%;height:480px;border:1px solid var(--line-strong);border-radius:8px;background:#fff";
          bar.append(el("b", "small", "Your website is ready."), dl, frame);
        }
        runEl.append(bar);
      }
    }
  }

  let askBuild = false;
  let autoBuild = false;
  // The research waits while the person is away (window hidden or page left) and carries on when they return.
  const setAway = (away) => { if (runId) bridge.backendRequest("research.pause", { run_id: runId, paused: away }); };
  document.addEventListener("visibilitychange", () => setAway(document.hidden || (viewEl && viewEl.hidden)));
  const viewEl = document.getElementById("view-world");
  if (viewEl) new MutationObserver(() => setAway(viewEl.hidden || document.hidden)).observe(viewEl, { attributes: true, attributeFilter: ["hidden"] });
  const noteForm = document.getElementById("world-note-form");
  const noteEl = document.getElementById("world-note");
  noteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = noteEl.value.trim();
    if (!text || !snap) return;
    const res = await bridge.backendRequest("research.note", { run_id: snap.run_id, text });
    if (!res.ok) { toast((res.error && res.error.message) || "Could not send."); return; }
    noteEl.value = "";
    toast("Sent. FIDEX AI will use it in its next step.");
  });
  const buildNowEl = document.getElementById("world-build-now");
  buildNowEl.addEventListener("click", async () => {
    if (!runId) return;
    if (!window.confirm("Allow FIDEX AI to finish the research now and ask to start solving?")) return;
    autoBuild = false;
    buildNowEl.hidden = true;
    hint("Wrapping up the research quickly...");
    await bridge.backendRequest("research.finish", { run_id: runId });
  });
  // Take Over in "solving real world problem" mode: eyes and hands active, brain aware of the research.
  function startSolving(s) {
    const r = s.report || {};
    const reco = r.recommendation ? `${r.recommendation.choice}: ${r.recommendation.why}` : "";
    const plan = (r.plan || []).map((p, i) => `${i + 1}. ${p.step}`).join(" ");
    const slug = (s.problem || "problem").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "problem";
    const text = `Create a new folder named fidex-${slug} on the Desktop and open it with VS Code, then prepare to solve the problem there. ` +
      `MODE: SOLVING REAL WORLD PROBLEM. Eyes and hands are active on this; it is the real problem, not a test. The brain knows the research. ` +
      `Problem: ${s.problem}. Summary: ${r.summary || ""}. Recommended: ${reco}. Plan: ${plan}`;
    const id = `world-${Date.now()}`;
    if (!bridge.inElectron) { toast("Solving opens in the desktop app."); return; }
    bridge.openOverlay({ id, text, mode: "world" }, { alwaysOnTop: true });
    hint("Solving real world problem: Take Over is active.");
  }
  async function startBuild(s) {
    const res = await bridge.backendRequest("research.build", { run_id: s.run_id });
    if (!res.ok) { toast((res.error && res.error.message) || "Could not start building."); return; }
    s.build = { status: "running" };
    render();
    poll2(s.run_id);
  }
  function poll2(id) {
    const t = setInterval(async () => {
      const res = await bridge.backendRequest("research.status", { run_id: id });
      if (!res.ok || !res.data) { clearInterval(t); return; }
      if (res.data.build && res.data.build.status !== "running") {
        clearInterval(t);
        snap = res.data;
        saveResearch(snap);
        render();
      }
    }, 2000);
  }

  function updateSub() {
    const sub = runEl.querySelector("#rs-sub");
    if (!sub || !snap) return;
    const end = snap.status === "running" ? Date.now() / 1000 : snap.activities.reduce((m, a) => Math.max(m, a.finished || 0), snap.started);
    const focus = (AREAS.find((a) => a.id === snap.focus) || {}).label || "";
    sub.textContent = `${focus} · ${fmtSecs(Math.max(0, end - snap.started))} · ${snap.sources.filter((x) => x.read).length} source(s) read`;
  }

  function setRunning(on) {
    startEl.hidden = on;
    stopEl.hidden = !on;
    buildNowEl.hidden = !on;
    topicEl.disabled = on;
    clearInterval(ticker);
    clearInterval(poll);
    if (on) {
      ticker = setInterval(updateSub, 1000);
      poll = setInterval(refreshFromBackend, 3000); // safety net in case an event was missed
    }
  }

  function apply(s) {
    snap = s;
    render();
    if (s.status === "running") {
      hint(s.paused ? "Paused while you are away. It continues when you come back." : "Researching... it pauses if you leave and continues when you return.");
    } else {
      setRunning(false);
      if (s.status === "done" && !s.build && autoBuild) { autoBuild = false; runId = null; saveResearch(s); hint("Research complete. Building..."); startBuild(s); return; }
      autoBuild = false;
      if (s.status === "done" && !s.build) askBuild = true; // research finished: ask permission to start building
      hint(s.status === "done" ? "Research complete." : s.status === "cancelled" ? "Research stopped." : "Research could not finish.");
      saveResearch(s);
      runId = null;
      render();
    }
  }

  async function refreshFromBackend() {
    if (!runId) return;
    const res = await bridge.backendRequest("research.status", { run_id: runId });
    if (!runId) return;
    if (res.ok && res.data) apply(res.data);
    else if (res.error && res.error.code === "NOT_FOUND") {
      snap = { ...snap, status: "failed", error: "The research stopped because the backend restarted.", notes: snap.notes || [], activities: snap.activities.map((a) => (a.state === "active" || a.state === "pending" ? { ...a, state: "failed" } : a)) };
      apply(snap);
    }
  }

  bridge.onBackendEvent((evt) => {
    if (!evt || evt.event !== "research.event" || !evt.data) return;
    if (runId && evt.data.run_id === runId) apply(evt.data);
    else if (starting) early.set(evt.data.run_id, evt.data);
  });

  // ---------- start / stop ----------
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (runId || starting) return;
    const problem = topicEl.value.trim();
    if (problem.length < 8) {
      hint("Describe the problem in a few words first.");
      topicEl.focus();
      return;
    }
    if (!bridge.inElectron) {
      hint("Research runs in the FIDEX AI desktop app. Nothing was started.");
      return;
    }
    starting = true;
    early.clear();
    startEl.disabled = true;
    hint("Starting research...");
    const res = await bridge.backendRequest("research.start", { problem, focus: selected });
    starting = false;
    startEl.disabled = false;
    if (!res.ok) {
      hint((res.error && res.error.message) || "Research could not start.");
      return;
    }
    runId = res.data.run_id;
    setRunning(true);
    apply(early.get(runId) || { run_id: runId, problem, focus: selected, status: "running", started: Date.now() / 1000, activities: [], sources: [], findings: [], report: null, notes: [] });
    if (!runId) return; // the first snapshot already finished the run
    refreshFromBackend();
  });

  stopEl.addEventListener("click", async () => {
    if (!runId) return;
    stopEl.disabled = true;
    await bridge.backendRequest("research.cancel", { run_id: runId });
    stopEl.disabled = false;
    hint("Stopping...");
  });

  topicEl.addEventListener("input", () => {
    if (!runId) hint("Describe a problem, choose a focus and start the research.");
  });

  // The last finished research is shown again after a restart (saved with the other local data).
  const last = loadResearch();
  if (last && last.status && last.activities) {
    snap = last;
    selected = AREAS.some((a) => a.id === last.focus) ? last.focus : "any";
    syncChips();
    render();
    hint("Showing your last research.");
  }
  setRunning(false);
}
