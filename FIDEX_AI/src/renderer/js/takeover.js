// Take Over page: instruction box, example instructions and the list of recent assignments.
// Sending an instruction only starts the simulated activity flow (see agent-sim.js and overlay.js).

import { createCommandBox } from "./commandbox.js";

const EXAMPLES = [
  "Build a website for my new business",
  "Research the market for a product idea",
  "Plan the launch and promotion of my product",
  "Review my project folder and list what is missing",
];

const STATUS = { done: "Complete (simulated)", stopped: "Stopped", waiting: "Waiting for you", working: "In progress" };
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
    btn.addEventListener("click", () => onPick(cmd.text));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

export function createTakeOver({ formEl, inputEl, sendEl, micEl, examplesEl, recentEl, recentEmptyEl, onSubmit, onMic, onPickRecent }) {
  const box = createCommandBox({ formEl, inputEl, sendEl, micEl, onSubmit, onMic });

  for (const text of EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      box.setValue(text);
      box.focus();
    });
    examplesEl.appendChild(chip);
  }

  const renderRecent = (commands) => renderRecentList(recentEl, recentEmptyEl, commands, onPickRecent);

  return { ...box, renderRecent };
}
