// History page: saved conversations and Take Over assignments.

import { statusLabel } from "./takeover.js";

const fmt = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function createHistory({ els, onOpenChat, onDeleteChat, onOpenCommand, onDeleteCommand }) {
  let tab = "chats";
  let data = { conversations: [], commands: [] };

  function row({ title, meta, onOpen, onDelete, label }) {
    const li = document.createElement("li");
    li.className = "list-row";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "list-main";
    const b = document.createElement("b");
    b.textContent = title;
    b.title = title;
    const i = document.createElement("i");
    i.textContent = meta;
    main.append(b, i);
    main.addEventListener("click", onOpen);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.setAttribute("aria-label", label);
    del.title = label;
    del.innerHTML = '<svg class="ic ic-sm"><use href="#i-trash"></use></svg>';
    del.addEventListener("click", onDelete);

    li.append(main, del);
    return li;
  }

  function render(conversations = data.conversations, commands = data.commands) {
    data = { conversations, commands };
    els.countChats.textContent = String(conversations.length);
    els.countCommands.textContent = String(commands.length);

    els.chatsTab.classList.toggle("active", tab === "chats");
    els.chatsTab.setAttribute("aria-selected", String(tab === "chats"));
    els.commandsTab.classList.toggle("active", tab === "commands");
    els.commandsTab.setAttribute("aria-selected", String(tab === "commands"));
    els.chatsList.hidden = tab !== "chats";
    els.commandsList.hidden = tab !== "commands";

    els.chatsList.replaceChildren(
      ...conversations.map((c) =>
        row({
          title: c.title,
          meta: `${c.messages.length} message${c.messages.length === 1 ? "" : "s"} \u00b7 ${fmt(c.updatedAt)}`,
          label: "Delete conversation",
          onOpen: () => onOpenChat(c.id),
          onDelete: () => onDeleteChat(c.id),
        })
      )
    );
    els.commandsList.replaceChildren(
      ...commands.map((c) =>
        row({
          title: c.text,
          meta: `${statusLabel(c)} \u00b7 ${fmt(c.time)}`,
          label: "Delete assignment",
          onOpen: () => onOpenCommand(c.text, c),
          onDelete: () => onDeleteCommand(c.id),
        })
      )
    );

    const empty = tab === "chats" ? conversations.length === 0 : commands.length === 0;
    els.empty.hidden = !empty;
    els.empty.textContent = tab === "chats" ? "No conversations yet. Start one from the home screen." : "No assignments yet.";
  }

  els.chatsTab.addEventListener("click", () => {
    tab = "chats";
    render();
  });
  els.commandsTab.addEventListener("click", () => {
    tab = "commands";
    render();
  });

  return { render };
}
