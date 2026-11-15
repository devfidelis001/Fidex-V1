// Chat area: message list and the composer (input + Send button).

export function createChat({ messagesEl, emptyEl, formEl, inputEl, sendEl, onSend }) {
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > 160 ? "auto" : "hidden"; // scrollbar only when needed
  }

  function syncSend() {
    sendEl.disabled = inputEl.value.trim() === "";
  }

  function buildMessage(msg) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (msg.role === "user" ? "msg-user" : "msg-ai");

    const label = document.createElement("p");
    label.className = "msg-label";
    label.textContent = msg.role === "user" ? "You" : "FIDEX AI";
    if (msg.placeholder) {
      const tag = document.createElement("span");
      tag.className = "tag-placeholder";
      tag.textContent = "PLACEHOLDER";
      label.appendChild(tag);
    }

    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = msg.text; // text only, never HTML

    wrap.append(label, body);
    return wrap;
  }

  function render(conversation) {
    messagesEl.querySelectorAll(".msg").forEach((n) => n.remove());
    const messages = conversation ? conversation.messages : [];
    emptyEl.hidden = messages.length > 0;
    for (const m of messages) messagesEl.appendChild(buildMessage(m));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  inputEl.addEventListener("input", () => {
    autosize();
    syncSend();
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      formEl.requestSubmit();
    }
  });

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    autosize();
    syncSend();
    onSend(text);
  });

  return { render, focus: () => inputEl.focus() };
}
