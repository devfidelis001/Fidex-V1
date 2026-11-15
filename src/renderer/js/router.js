// Switches between the pages of the workspace and highlights the matching sidebar item.

export function createRouter({ rootEl, onEnter }) {
  const views = Array.from(rootEl.querySelectorAll("[data-view]"));
  const navItems = Array.from(document.querySelectorAll(".nav-item[data-route]"));
  let current = "chat";

  function go(name) {
    const exists = views.some((v) => v.dataset.view === name);
    if (!exists) name = "chat";
    current = name;
    for (const v of views) v.hidden = v.dataset.view !== name;
    for (const n of navItems) n.classList.toggle("active", n.dataset.route === name);
    if (onEnter) onEnter(name);
  }

  return { go, current: () => current };
}
