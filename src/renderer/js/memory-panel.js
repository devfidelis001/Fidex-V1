// Memory panel: review, edit, add and delete what FIDEX AI remembers. Opened by typing /memory in the chat.
// Self-contained (builds its own overlay), text only - never inserts HTML.
import { bridge } from "./bridge.js";

let overlay = null;

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

export function openMemoryPanel() {
  if (overlay) return;
  overlay = el("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
  const box = el("div");
  box.style.cssText = "width:min(640px,92vw);max-height:84vh;overflow:auto;padding:16px;border-radius:12px;background:var(--panel-bg,#1f1f23);color:var(--text,#eee);font:14px system-ui,sans-serif";
  const status = el("p", { textContent: "Loading..." });
  const list = el("div");
  const close = () => {
    overlay.remove();
    overlay = null;
  };
  const head = el("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px";
  head.append(el("strong", { textContent: "What FIDEX SI remembers" }), el("button", { textContent: "Close", onclick: close }));

  const addRow = el("div");
  addRow.style.cssText = "display:flex;gap:6px;margin:8px 0";
  const addCat = el("select");
  const addText = el("input", { placeholder: "Add something to remember..." });
  addText.style.flex = "1";
  addRow.append(addCat, addText, el("button", { textContent: "Add", onclick: async () => {
    if (!addText.value.trim()) return;
    const res = await bridge.backendRequest("memory.add", { category: addCat.value, content: addText.value });
    if (res.ok) { addText.value = ""; load(); } else status.textContent = res.error.message;
  } }));

  async function load() {
    const res = await bridge.backendRequest("memory.list", {});
    list.textContent = "";
    if (!res.ok) { status.textContent = res.error.message; return; }
    const cats = res.data.categories;
    if (!addCat.options.length) cats.forEach((c) => addCat.add(new Option(c, c, false, c === "fact")));
    status.textContent = res.data.memories.length ? `${res.data.memories.length} memories stored on this computer.` : "Nothing remembered yet. Tell me about yourself, or add something below.";
    for (const m of res.data.memories) {
      const row = el("div");
      row.style.cssText = "display:flex;gap:6px;margin:4px 0;align-items:center";
      const tag = el("span", { textContent: m.category });
      tag.style.cssText = "min-width:78px;font-size:11px;opacity:.6";
      const input = el("input", { value: m.content });
      input.style.flex = "1";
      row.append(
        tag,
        input,
        el("button", { textContent: "Save", onclick: async () => {
          const r = await bridge.backendRequest("memory.update", { id: m.id, content: input.value });
          status.textContent = r.ok ? "Saved." : r.error.message;
        } }),
        el("button", { textContent: "Delete", onclick: async () => {
          const r = await bridge.backendRequest("memory.delete", { id: m.id });
          if (r.ok) load(); else status.textContent = r.error.message;
        } }),
      );
      list.appendChild(row);
    }
  }

  box.append(head, status, addRow, list);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  load();
}
