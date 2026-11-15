// Guide Me: plan a task, follow the steps, track progress and resume unfinished work.
// Plans are saved locally and mirrored to the backend (task.* -> SQLite) so they survive restarts.
// Nothing is executed: this is the user's own checklist, structured by FIDEX AI.

import { loadPlans, savePlans, newId } from "./storage.js";
import { db } from "./db-client.js";
import { createAgentAi } from "./agent-ai.js";

// Turns a goal into ordered steps. Rule-based and offline: lines the user typed become steps;
// otherwise a standard path is generated from the goal.
export function planSteps(goal, extra = "") {
  const lines = String(extra)
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  const labels = lines.length
    ? lines
    : [
        `Define what "${clip(goal, 60)}" should achieve and how you will know it is done`,
        "List what you already have and what is missing",
        "Break the work into small pieces and order them",
        "Do the first piece and check the result",
        "Work through the remaining pieces",
        "Review everything against the goal and fix gaps",
        "Finish: deliver, publish or hand over the result",
      ];
  return labels.slice(0, 30).map((label) => ({ id: newId(), label: clip(label, 200), done: false }));
}

const clip = (t, n) => (t.length > n ? t.slice(0, n - 3) + "..." : t);
export const progressOf = (plan) => (plan.steps.length ? Math.round((plan.steps.filter((s) => s.done).length / plan.steps.length) * 100) : 0);
export const statusOf = (plan) => {
  const p = progressOf(plan);
  return p === 100 ? "completed" : p === 0 ? "pending" : "in_progress";
};

async function mirror(plan) {
  const fields = { title: clip(plan.goal, 200), description: plan.steps.map((s) => `${s.done ? "[x]" : "[ ]"} ${s.label}`).join("\n").slice(0, 10000), status: statusOf(plan) };
  const res = plan.synced ? await db.tasks.update(plan.id, fields) : await db.tasks.create({ id: plan.id, ...fields });
  if (res.ok) plan.synced = true;
  return res.ok;
}

export function createGuide({ els, toast }) {
  let plans = loadPlans();
  let openId = null;
  const persist = () => {
    savePlans(plans);
  };

  const find = () => plans.find((p) => p.id === openId) || null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderList() {
    els.list.replaceChildren();
    els.empty.hidden = plans.length > 0;
    const unfinished = plans.filter((p) => progressOf(p) < 100);
    els.resume.hidden = unfinished.length === 0;
    if (unfinished.length) {
      const last = unfinished.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      els.resumeText.textContent = `Unfinished: "${clip(last.goal, 60)}" (${progressOf(last)}% done)`;
      els.resumeBtn.onclick = () => open(last.id);
    }
    for (const plan of plans.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
      const li = el("li", "list-row");
      const main = el("button", "list-main");
      main.type = "button";
      main.append(el("b", null, plan.goal), el("i", null, `${progressOf(plan)}% done \u00b7 ${plan.steps.filter((s) => s.done).length}/${plan.steps.length} steps`));
      main.addEventListener("click", () => open(plan.id));
      const del = el("button", "icon-btn");
      del.type = "button";
      del.setAttribute("aria-label", "Delete plan");
      del.innerHTML = '<svg class="ic ic-sm"><use href="#i-trash" /></svg>';
      del.addEventListener("click", async () => {
        if (!window.confirm("Delete this plan?")) return;
        plans = plans.filter((p) => p.id !== plan.id);
        persist();
        db.tasks.delete(plan.id);
        if (openId === plan.id) openId = null;
        render();
      });
      li.append(main, del);
      els.list.appendChild(li);
    }
  }

  // Real AI guidance (Guide Me mode: uses the relevant permanent memory). Shown only; the plan itself is never changed by it.
  const ai = createAgentAi("guide");
  const guidanceEl = el("p", "guide-ai", "");
  guidanceEl.style.cssText = "margin:8px 0;font-size:13px;opacity:.85;white-space:pre-wrap";
  guidanceEl.hidden = true;
  const askBtn = el("button", "btn", "Ask FIDEX AI for guidance");
  askBtn.type = "button";
  askBtn.addEventListener("click", async () => {
    const plan = find();
    if (!plan || ai.busy) return;
    const next = plan.steps.find((s) => !s.done);
    ai.reset();
    guidanceEl.hidden = false;
    guidanceEl.textContent = "FIDEX AI is thinking...";
    const done = plan.steps.filter((s) => s.done).length;
    const out = await ai.ask(`My goal: ${plan.goal}. ${done}/${plan.steps.length} steps done. ${next ? "Next step: " + next.label + ". Guide me through it." : "All steps are done. Suggest what to check or do next."}`, (partial) => {
      guidanceEl.textContent = partial;
    });
    guidanceEl.textContent = out.text || out.error; // final answer only
  });

  function renderPlan() {
    const plan = find();
    els.plan.hidden = !plan;
    if (!plan) return;
    els.planTitle.textContent = plan.goal;
    const pct = progressOf(plan);
    els.bar.style.width = pct + "%";
    els.pct.textContent = pct + "%";
    els.steps.replaceChildren();
    const next = plan.steps.find((s) => !s.done);
    if (!askBtn.isConnected) els.next.after(askBtn, guidanceEl);
    guidanceEl.hidden = true;
    els.next.textContent = next ? `Next step: ${next.label}` : "All steps done. Well done.";
    for (const step of plan.steps) {
      const li = el("li", "gd-step" + (step.done ? " done" : "") + (next && next.id === step.id ? " current" : ""));
      const cb = el("input", "gd-check");
      cb.type = "checkbox";
      cb.checked = step.done;
      cb.setAttribute("aria-label", step.label);
      cb.addEventListener("change", () => {
        step.done = cb.checked;
        touch(plan);
      });
      li.append(cb, el("span", null, step.label));
      els.steps.appendChild(li);
    }
  }

  async function touch(plan) {
    plan.updatedAt = Date.now();
    persist();
    render();
    await mirror(plan);
    persist();
  }

  function render() {
    renderList();
    renderPlan();
  }

  function open(id) {
    openId = id;
    render();
    els.plan.scrollIntoView({ block: "nearest" });
  }

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const goal = els.goal.value.trim();
    if (!goal) {
      els.goal.focus();
      return;
    }
    const plan = { id: newId(), goal, steps: planSteps(goal, els.stepsInput.value), createdAt: Date.now(), updatedAt: Date.now(), synced: false };
    plans.unshift(plan);
    els.goal.value = "";
    els.stepsInput.value = "";
    persist();
    openId = plan.id;
    render();
    await mirror(plan);
    persist();
    toast("Plan created. Tick steps off as you go.");
  });

  els.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const plan = find();
    const text = els.addInput.value.trim();
    if (!plan || !text) return;
    plan.steps.push({ id: newId(), label: clip(text, 200), done: false });
    els.addInput.value = "";
    touch(plan);
  });

  els.close.addEventListener("click", () => {
    openId = null;
    render();
  });

  // On start, plans the backend knows about but this device lost (e.g. cleared storage) come back.
  async function restoreFromBackend() {
    const res = await db.tasks.list({ limit: 100 });
    if (!res.ok || !res.data) return;
    const rows = res.data.tasks || res.data.items || [];
    let added = 0;
    for (const t of rows) {
      if (plans.some((p) => p.id === t.id) || !t.description || !/^\[[ x]\] /m.test(t.description)) continue;
      const steps = t.description.split("\n").filter((l) => /^\[[ x]\] /.test(l)).map((l) => ({ id: newId(), label: l.slice(4), done: l[1] === "x" }));
      if (!steps.length) continue;
      plans.push({ id: t.id, goal: t.title, steps, createdAt: Date.now(), updatedAt: Date.parse(t.updated_at) || Date.now(), synced: true });
      added += 1;
    }
    if (added) {
      persist();
      render();
    }
  }

  return { load: render, restoreFromBackend };
}
