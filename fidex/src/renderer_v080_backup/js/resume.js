// After a restart: find the work that was saved but never finished (Step 6) and mark the matching
// assignments so the user can continue them. Only reads; nothing is started or executed here.

import { db } from "./db-client.js";

const LIVE = new Set(["working", "waiting", "assigned"]);

/**
 * Updates `commands` (the saved assignment list) in place.
 * Returns {restored, unsaved, changed}, or null when the backend could not be asked (then nothing is
 * changed and nothing is claimed).
 */
export async function markUnfinished(commands, restore = () => db.work.restore()) {
  const res = await restore();
  if (!res.ok) return null;
  const saved = new Map(res.data.tasks.map((t) => [t.task.id, t]));
  let restored = 0;
  let unsaved = 0;
  for (const cmd of commands) {
    const entry = saved.get(cmd.id);
    if (entry) {
      cmd.status = "interrupted";
      cmd.stage = entry.resume.stopped_at ? entry.resume.stopped_at.label : cmd.stage;
      cmd.savedProgress = entry.task.progress;
      saved.delete(cmd.id);
      restored += 1;
    } else if (LIVE.has(cmd.status)) {
      cmd.status = "unsaved"; // it was running when FIDEX AI closed, but nothing about it reached the database
      unsaved += 1;
    }
  }
  // Saved work whose assignment entry is gone (for example cleared history) is still offered.
  for (const entry of saved.values()) {
    commands.unshift({
      id: entry.task.id,
      text: entry.task.instruction || entry.task.title,
      time: Date.parse(entry.task.created_at) || Date.now(),
      source: "restored",
      status: "interrupted",
      stage: entry.resume.stopped_at ? entry.resume.stopped_at.label : "",
      savedProgress: entry.task.progress,
    });
    restored += 1;
  }
  return { restored, unsaved, changed: restored + unsaved > 0 };
}
