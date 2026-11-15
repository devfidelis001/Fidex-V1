// Sidebar behaviour on narrow windows (it becomes a slide-over panel).

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
