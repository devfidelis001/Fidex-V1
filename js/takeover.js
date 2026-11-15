// Take Over page: instruction box and the list of recent assignments.
// Sending an instruction opens the Take Over panel (see overlay.js and agent-core.js).

import { createCommandBox } from "./commandbox.js";

const STATUS = {
  done: "Complete",
  stopped: "Stopped",
  waiting: "Waiting for you",
  working: "In progress",
  interrupted: "Interrupted: click to continue", // progress was saved (Step 6)
  unsaved: "Interrupted, progress not saved", // FIDEX AI closed before anything was saved
};
export const statusLabel = (cmd) => STATUS[cmd.status] || "Assigned";

// Renders the short "recent assignments" list. Used by the Take Over page and the home screen.
export function renderRecentList(listEl, emptyEl, commands, onPick) {
  listEl.replaceChildren();
  emptyEl.hidden = commands.length > 0;
  for (const cmd of commands.slice(0, 3)) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mini-item";
    const label = document.createElement("span");
    label.textContent = cmd.text;
    label.title = cmd.text;
    const when = document.createElement("em");
    when.textContent = statusLabel(cmd);
    btn.append(label, when);
    btn.addEventListener("click", () => onPick(cmd.text, cmd));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

export function createTakeOver({ formEl, inputEl, sendEl, micEl, recentEl, recentEmptyEl, onSubmit, onMic, onPickRecent }) {
  const box = createCommandBox({ formEl, inputEl, sendEl, micEl, onSubmit, onMic });

  const renderRecent = (commands) => renderRecentList(recentEl, recentEmptyEl, commands, onPickRecent);

  return { ...box, renderRecent };
}
