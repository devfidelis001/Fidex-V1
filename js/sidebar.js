// Sidebar behaviour on narrow windows (it becomes a slide-over panel).

import { makeTitle } from "./storage.js";

// The 3 most recent conversations, shown in the sidebar. Reads the same saved conversations as History.
export function renderRecentChats(listEl, emptyEl, conversations, activeId, onPick) {
  listEl.replaceChildren();
  const recent = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  emptyEl.hidden = recent.length > 0;
  for (const c of recent) {
    const firstUser = (c.messages || []).find((m) => m.role === "user");
    const title = firstUser ? makeTitle(firstUser.text) : c.title || "New chat";
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-item chat-item" + (c.id === activeId ? " active" : "");
    btn.title = c.title && c.title !== title ? `${title}\n${c.title}` : title;
    const label = document.createElement("span");
    label.textContent = title;
    btn.appendChild(label);
    btn.addEventListener("click", () => onPick(c.id));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

export function createSidebar({ workspaceEl, backdropEl }) {
  function openPanel() {
    workspaceEl.classList.add("sidebar-open");
    backdropEl.hidden = false;
  }

  function closePanel() {
    workspaceEl.classList.remove("sidebar-open");
    backdropEl.hidden = true;
  }

  backdropEl.addEventListener("click", closePanel);

  return { openPanel, closePanel };
}
