// Pure translation between the Take Over panel's state (agent-core.js) and the saved-progress
// records of the Python backend (Step 6). No I/O here, so it is easy to test.

const clip = (text, max) => String(text ?? "").slice(0, max);

const STATUS_TO_DB = { idle: "in_progress", working: "in_progress", waiting: "in_progress", done: "completed", stopped: "cancelled" };

// Everything worth keeping from one panel state, as a `work.save` payload. Saving the same state
// twice is harmless: the backend upserts by id and de-duplicates context.
export function toSavePayload(state, stepIds) {
  const text = state.task.text;
  const context = [{ kind: "project", content: clip(text, 10000) }];
  for (const note of state.notes || []) context.push({ kind: "instruction", content: clip(note.text, 10000) });
  for (const r of state.requests) {
    if (r.state !== "answered" || r.answer == null) continue;
    if (r.kind === "approval") context.push({ kind: "decision", content: clip(`${r.answer === "approved" ? "Approved" : "Declined"}: ${r.text}`, 10000) });
    else context.push({ kind: "instruction", content: clip(`${r.text} ${r.answer}`, 10000) });
  }
  const step = stepIds && stepIds[state.phase];
  return {
    id: state.task.id,
    title: clip(text.trim() || "Untitled task", 200),
    instruction: clip(text, 10000),
    status: STATUS_TO_DB[state.status] || "in_progress",
    progress: Math.max(0, Math.min(100, Math.round(state.progress || 0))),
    phase: step || undefined,
    activity: clip(state.status === "waiting" ? state.why || state.doing : state.doing, 400),
    steps: state.steps.map((s) => ({ key: s.id, label: s.label, state: s.state })),
    requests: state.requests.map((r) => ({
      key: r.id,
      kind: r.kind,
      text: clip(r.text, 200),
      detail: clip(r.detail || "", 10000),
      state: r.state,
      answer: r.answer == null ? null : clip(r.answer, 10000),
      consequential: r.kind === "approval",
    })),
    context,
  };
}

// A `work.restore` entry -> the fields the panel needs to carry on from where it stopped.
export function fromRestored(entry) {
  const steps = entry.steps.map((s) => ({ id: s.key, label: s.label, state: s.state === "skipped" ? "done" : s.state }));
  const firstOpen = steps.findIndex((s) => s.state !== "done");
  return {
    task: { id: entry.task.id, text: entry.task.instruction || entry.task.title },
    phase: firstOpen === -1 ? Math.max(0, steps.length - 1) : firstOpen,
    progress: entry.task.progress,
    steps,
    requests: entry.requests.map((r) => ({ id: r.key, kind: r.kind, text: r.text, detail: r.detail || undefined, state: r.state, answer: r.answer })),
    savedAt: entry.task.updated_at,
    startedAt: Date.parse(entry.task.created_at) || undefined, // keep the ORIGINAL start time across restarts
    summary: entry.resume.summary,
    reopened: (entry.resume.needs_reapproval || []).map((r) => r.text),
  };
}
