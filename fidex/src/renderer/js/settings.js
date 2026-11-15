// Settings page.

export function createSettings({ els, getSettings, onChange, onClearChats, onClearCommands, onShowWelcome }) {
  function load() {
    const s = getSettings();
    els.autoCompact.checked = s.autoCompact;
    els.onTop.checked = s.compactOnTop;
  }

  function refresh(conversationCount, commandCount) {
    load();
    const c = conversationCount === 1 ? "1 saved conversation" : `${conversationCount} saved conversations`;
    const t = commandCount === 1 ? "1 Take Over instruction" : `${commandCount} Take Over instructions`;
    els.count.textContent = `${c} \u00b7 ${t}`;
  }

  els.autoCompact.addEventListener("change", () => onChange({ autoCompact: els.autoCompact.checked }));
  els.onTop.addEventListener("change", () => onChange({ compactOnTop: els.onTop.checked }));

  els.clearChats.addEventListener("click", () => {
    if (window.confirm("Delete all saved conversations? This cannot be undone.")) onClearChats();
  });
  els.clearCommands.addEventListener("click", () => {
    if (window.confirm("Delete all Take Over history? This cannot be undone.")) onClearCommands();
  });
  els.showWelcome.addEventListener("click", onShowWelcome);

  return { refresh };
}
