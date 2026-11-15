// Chat area: message list and the composer (input + Send button).

let thinkStart = null; // when the current answer started, to show how long it took

export function createChat({ messagesEl, emptyEl, formEl, inputEl, sendEl, onSend }) {
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > 160 ? "auto" : "hidden"; // scrollbar only when needed
  }

  function syncSend() {
    sendEl.disabled = inputEl.value.trim() === "";
  }

  // One card, two independent sections: FIDEX MIND (short progress lines) on top, YOUR RESPONSE (the answer) below.
  function buildCard(msg) {
    const card = document.createElement("div");
    card.className = "msg-body ai-card";
    const mind = document.createElement("div");
    mind.className = "ai-mind";
    const mindHead = document.createElement("p");
    mindHead.className = "ai-sec";
    mindHead.textContent = "FIDEX MIND";
    if (msg.live) {
      const dot = document.createElement("span"); // glowing dot only while generating
      dot.className = "ai-dot";
      mindHead.appendChild(dot);
    }
    const list = document.createElement("ul");
    list.className = "ai-mind-list";
    for (const line of msg.mind || []) {
      const li = document.createElement("li");
      li.textContent = line;
      list.appendChild(li);
    }
    mind.append(mindHead, list);
    const resp = document.createElement("div");
    resp.className = "ai-resp";
    const respHead = document.createElement("p");
    respHead.className = "ai-sec";
    respHead.textContent = "YOUR RESPONSE";
    const text = document.createElement("div");
    text.className = "ai-resp-text";
    text.textContent = msg.text || ""; // text only, never HTML
    if (msg.live) {
      text.classList.add("is-loading"); // YOUR RESPONSE shows only a loading indicator while FIDEX works
      text.innerHTML = '<span class="ai-load"><i></i><i></i><i></i></span>';
    }
    resp.append(respHead, text);
    card.append(mind, resp);
    return card;
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

    const hasMind = msg.role !== "user" && Array.isArray(msg.mind) && msg.mind.length > 0;
    const body = hasMind || msg.live ? buildCard(msg) : document.createElement("div");
    if (!hasMind && !msg.live) {
      body.className = "msg-body";
      body.textContent = msg.text; // text only, never HTML
    }

    wrap.append(label, body);
    return wrap;
  }

  function render(conversation) {
    messagesEl.querySelectorAll(".msg").forEach((n) => n.remove());
    const messages = conversation ? conversation.messages : [];
    emptyEl.hidden = messages.length > 0;
    for (const m of messages) messagesEl.appendChild(buildMessage(m));
    if (thinkStart !== null && messages.length) {
      const aiMsgs = messagesEl.querySelectorAll(".msg-ai");
      const last = aiMsgs[aiMsgs.length - 1];
      if (last && messages[messages.length - 1].role !== "user") {
        const meta = document.createElement("p");
        meta.className = "msg-meta";
        meta.style.cssText = "margin:4px 0 0;font-size:11px;opacity:.55";
        meta.textContent = `answered in ${((Date.now() - thinkStart) / 1000).toFixed(1)} s`;
        last.appendChild(meta);
      }
      thinkStart = null;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Live card while the AI works. render() replaces it with the saved message.
  let liveNode = null;
  function showThinking() {
    messagesEl.querySelectorAll(".msg-thinking").forEach((n) => n.remove());
    emptyEl.hidden = true;
    const node = buildMessage({ role: "assistant", text: "", mind: [], live: true });
    node.classList.add("msg-thinking");
    liveNode = node;
    messagesEl.appendChild(node);
    thinkStart = Date.now();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // FIDEX MIND: add one real progress line (from the backend). Independent of the answer text.
  function stage(line) {
    if (!liveNode || !liveNode.isConnected) return;
    const list = liveNode.querySelector(".ai-mind-list");
    list.querySelector(".ai-wait")?.remove();
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
    while (list.children.length > 40) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // YOUR RESPONSE: shows the FINAL answer only, once generation has finished (replaces the loading indicator).
  function showAnswer(text) {
    if (!liveNode || !liveNode.isConnected) return;
    const el = liveNode.querySelector(".ai-resp-text");
    el.classList.remove("is-loading");
    el.textContent = text || "";
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Ends the glowing dot cleanly; resolves when the animation is over (the caller then shows the saved message).
  function finish() {
    const node = liveNode;
    liveNode = null;
    if (!node || !node.isConnected) return Promise.resolve();
    const dot = node.querySelector(".ai-dot");
    dot.classList.add("is-done");
    return new Promise((r) => setTimeout(r, 450));
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

  return { render, showThinking, showAnswer, stage, finish, focus: () => inputEl.focus() };
}
