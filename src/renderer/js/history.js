// History page: saved conversations.

const fmt = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function createHistory({ els, onOpenChat, onDeleteChat, onClearAll, onStartOver }) {
  if (els.clearAll && onClearAll) els.clearAll.addEventListener("click", onClearAll);
  if (els.startOver && onStartOver) els.startOver.addEventListener("click", onStartOver);
  let data = { conversations: [] };

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

  function render(conversations = data.conversations) {
    data = { conversations };
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
    els.empty.hidden = conversations.length !== 0;
  }

  return { render };
}
