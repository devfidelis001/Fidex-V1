import { attachMic } from "./chat-mic.js";
import { attachReader } from "./reader.js";

// Chat area: message list and the composer (input + Send button; the button becomes Stop while the AI is generating).

let thinkStart = null; // when the current answer started, to show how long it took

export function createChat({ messagesEl, emptyEl, formEl, inputEl, sendEl, onSend }) {
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > 160 ? "auto" : "hidden"; // scrollbar only when needed
  }

  // Send <-> Stop. While generating the button is always enabled and clicking it stops the answer.
  let generating = false;
  let onStopClick = null;
  const sendIcon = sendEl.querySelector("use");

  function syncSend() {
    sendEl.disabled = generating ? false : inputEl.value.trim() === "";
  }

  function setGenerating(on, onStop) {
    generating = Boolean(on);
    onStopClick = generating ? onStop || null : null;
    sendEl.type = generating ? "button" : "submit"; // Stop must never submit the form
    sendEl.setAttribute("aria-label", generating ? "Stop" : "Send");
    sendEl.title = generating ? "Stop generating" : "";
    sendEl.classList.toggle("is-stop", generating);
    if (sendIcon) sendIcon.setAttribute("href", generating ? "#i-stop" : "#i-send");
    syncSend();
  }

  sendEl.addEventListener("click", (e) => {
    if (!generating) return;
    e.preventDefault(); // the button turns back into Send during this click; it must not also submit the form
    if (onStopClick) onStopClick();
  });

  // One card: YOUR RESPONSE (the answer). The glowing dot shows only while generating.
  function buildCard(msg) {
    const card = document.createElement("div");
    card.className = "msg-body ai-card";
    const resp = document.createElement("div");
    resp.className = "ai-resp";
    const respHead = document.createElement("p");
    respHead.className = "ai-sec";
    respHead.textContent = "YOUR RESPONSE";
    if (msg.live) {
      const dot = document.createElement("span");
      dot.className = "ai-dot";
      respHead.appendChild(dot);
    }
    const text = document.createElement("div");
    text.className = "ai-resp-text";
    text.textContent = msg.text || ""; // text only, never HTML
    if (msg.live) {
      text.classList.add("is-loading"); // YOUR RESPONSE shows only a loading indicator while FIDEX works
      text.innerHTML = '<span class="ai-load"><i></i><i></i><i></i></span>';
    }
    resp.append(respHead, text);
    card.append(resp);
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

    const useCard = msg.live || (msg.role !== "user" && (msg.card || (Array.isArray(msg.mind) && msg.mind.length > 0))); // older saved answers keep the card look
    const body = useCard ? buildCard(msg) : document.createElement("div");
    if (!useCard) {
      body.className = "msg-body";
      body.textContent = msg.text; // text only, never HTML
    }

    wrap.append(label, body);
    if (useCard && !msg.live && msg.text) attachReader(wrap, body.querySelector(".ai-resp-text"));
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
    const node = buildMessage({ role: "assistant", text: "", live: true });
    node.classList.add("msg-thinking");
    liveNode = node;
    messagesEl.appendChild(node);
    thinkStart = Date.now();
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

  // Real-time streaming: shows the text written so far inside YOUR RESPONSE (the glowing dot stays until the end).
  function streamAnswer(text) {
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

  // Stop: removes the live card at once (no animation delay).
  function discardLive() {
    const node = liveNode;
    liveNode = null;
    thinkStart = null;
    if (node && node.isConnected) node.remove();
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
    if (generating) return; // Enter does nothing while an answer is being written; Stop first
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    autosize();
    syncSend();
    onSend(text);
  });

  // Offline voice input: fills the input only; the user still presses Send.
  const micEl = formEl.querySelector("#chat-mic");
  if (micEl) {
    attachMic({
      micEl,
      getText: () => inputEl.value,
      onText: (text) => {
        inputEl.value = text;
        autosize();
        syncSend();
        inputEl.scrollTop = inputEl.scrollHeight;
      },
    });
  }

  return { render, showThinking, showAnswer, streamAnswer, finish, discardLive, setGenerating, focus: () => inputEl.focus() };
}
