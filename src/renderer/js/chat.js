import { attachMic } from "./chat-mic.js";
import { tts, createListenButton } from "./listen.js";
import { attachLive } from "./live-chat.js";
import { startAnim } from "./anim.js";

// Chat area: message list and the composer (input + Send button; the button becomes Stop while the AI is generating).


const DL_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>';
function downloadLink(href, name) {
  const a = document.createElement("a");
  a.className = "gen-dl"; a.href = href; a.download = name; a.title = "Download"; a.setAttribute("aria-label", "Download image");
  a.innerHTML = DL_ICON;
  return a;
}
let lightbox = null;
function openLightbox(src, name) {
  closeLightbox();
  const box = document.createElement("div");
  box.className = "gen-lightbox";
  const img = document.createElement("img"); img.alt = "Image"; img.src = src;
  const x = document.createElement("button"); x.type = "button"; x.className = "gen-lb-close"; x.setAttribute("aria-label", "Close"); x.innerHTML = "&times;";
  const dl = downloadLink(src, name); dl.classList.add("gen-lb-dl");
  img.addEventListener("click", (e) => e.stopPropagation());
  dl.addEventListener("click", (e) => e.stopPropagation());
  x.addEventListener("click", closeLightbox);
  box.addEventListener("click", closeLightbox);
  box.append(img, x, dl);
  document.body.appendChild(box);
  lightbox = box;
  document.addEventListener("keydown", onLbKey);
}
function onLbKey(e) { if (e.key === "Escape") closeLightbox(); }
function closeLightbox() { if (lightbox) { lightbox.remove(); lightbox = null; } document.removeEventListener("keydown", onLbKey); }

let thinkStart = null; // when the current answer started, to show how long it took

export function createChat({ messagesEl, emptyEl, formEl, inputEl, sendEl, onSend, attach, imageMode }) {
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > 160 ? "auto" : "hidden"; // scrollbar only when needed
  }

  // Scroll-down button: follow the answer only while the user is at the bottom; scrolled up = left alone, white button takes them down.
  let stick = true;
  const down = document.createElement("button");
  down.type = "button"; down.className = "scroll-down"; down.setAttribute("aria-label", "Scroll to the latest message"); down.title = "Scroll down";
  down.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  document.body.appendChild(down);
  function sync() {
    const r = messagesEl.getBoundingClientRect();
    stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
    down.style.left = r.left + r.width / 2 - 19 + "px";
    down.style.top = r.bottom - 54 + "px";
    down.classList.toggle("is-on", !stick && r.height > 0);
  }
  messagesEl.addEventListener("scroll", sync, { passive: true });
  if (typeof ResizeObserver === "function") new ResizeObserver(sync).observe(messagesEl); // also hides it when the chat page is not showing
  messagesEl.style.scrollBehavior = "auto"; // the glide below is driven by this code, not by the browser
  let glide = 0;
  const stopGlide = () => cancelAnimationFrame(glide);
  messagesEl.addEventListener("wheel", stopGlide, { passive: true });
  messagesEl.addEventListener("touchstart", stopGlide, { passive: true });
  down.addEventListener("click", () => { // fast, smooth glide to the newest text (follows the answer while it grows)
    stopGlide();
    const from = messagesEl.scrollTop, t0 = performance.now();
    const dur = Math.min(450, Math.max(220, (messagesEl.scrollHeight - messagesEl.clientHeight - from) * 0.3));
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3), end = messagesEl.scrollHeight - messagesEl.clientHeight;
      messagesEl.scrollTop = from + (end - from) * e;
      if (k < 1) glide = requestAnimationFrame(step); else { stick = true; sync(); }
    };
    glide = requestAnimationFrame(step);
  });

  // Send <-> Stop. While generating the button is always enabled and clicking it stops the answer.
  let generating = false;
  let onStopClick = null;
  const sendIcon = sendEl.querySelector("use");

  function syncSend() {
    sendEl.disabled = generating ? false : inputEl.value.trim() === "" && !(attach && attach.get());
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
    text.textContent = (msg.text || "") + (msg.stopped ? "....." : ""); // text only, never HTML; a stopped answer ends with five dots
    resp.append(respHead, text);
    card.append(resp);
    if (msg.role !== "user" && !msg.error && (msg.live || (msg.text && !msg.placeholder)) && !msg.stopped) {
    const row = createListenButton({ key: msg.live ? "live" : "m" + (msg.id || msg.time), getText: () => (msg.live ? text.textContent : msg.text) || "", isFinal: () => !msg.live, textEl: text });
    row.classList.add("ai-listen-row"); row.style.cssText = "position:absolute;left:-5px;top:calc(100% + 2px);margin:0;display:flex;line-height:0;gap:6px;z-index:5;pointer-events:auto"; // pinned right under the response container
    card.style.position = "relative"; card.style.overflow = "visible"; card.style.marginBottom = "32px"; card.append(row); // room for the icons: they never hide behind the input bar
    }
    return card;
  }

  function buildMessage(msg) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (msg.role === "user" ? "msg-user" : "msg-ai");

    const label = document.createElement("p");
    label.className = "msg-label";
    label.textContent = msg.role === "user" ? "You" : "FIDEX SI";
    const useCard = msg.live || (msg.role !== "user" && (msg.card || (Array.isArray(msg.mind) && msg.mind.length > 0))); // older saved answers keep the card look
    const body = useCard ? buildCard(msg) : document.createElement("div");
    if (!useCard) {
      body.className = "msg-body";
      if (msg.image && typeof msg.image === "string" && msg.image.startsWith("data:image/")) {
        const pic = document.createElement("img");
        pic.className = "msg-img"; pic.alt = "Attached image"; pic.src = msg.image;
        pic.style.cursor = "zoom-in"; pic.tabIndex = 0; pic.setAttribute("role", "button"); pic.title = "Click to enlarge";
        const openPic = () => openLightbox(msg.image, "fidex-image-" + (msg.time || Date.now()) + ".jpg"); // bigger view of the picture you sent
        pic.addEventListener("click", openPic);
        pic.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPic(); } });
        body.append(pic);
      }
      body.append(document.createTextNode(msg.text || "")); // text only, never HTML
    }

    if (msg.genImage && typeof msg.genImage === "string" && msg.genImage.startsWith("data:image/")) { // Image Creator result: small container, click to enlarge, download icon at the bottom
      const fig = document.createElement("div");
      fig.className = "gen-thumb";
      fig.tabIndex = 0; fig.setAttribute("role", "button"); fig.setAttribute("aria-label", "Open generated image"); fig.title = "Click to enlarge";
      const pic = document.createElement("img");
      pic.alt = "Generated image"; pic.src = msg.genImage;
      const dl = downloadLink(msg.genImage, "fidex-image-" + (msg.time || Date.now()) + ".jpg");
      dl.addEventListener("click", (e) => e.stopPropagation());
      fig.append(pic, dl);
      const open = () => openLightbox(msg.genImage, dl.download);
      fig.addEventListener("click", open);
      fig.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      body.append(fig);
    } else if (msg.genPrompt && msg.genGone) {
      const n = document.createElement("div"); n.className = "gen-gone"; n.textContent = "(Image not kept after restart. Generate it again.)"; body.append(n);
    }
    wrap.append(label, body);
    if (msg.stopped) { // same small grey line as the image-processing status, placed right under the answer
      const note = document.createElement("div");
      note.className = "ai-status-line is-stopped";
      note.innerHTML = '<span class="ai-status-label"></span><span class="ai-status-time"></span>';
      note.querySelector(".ai-status-label").textContent = "generation stopped";
      wrap.append(note);
    }
    return wrap;
  }

  function render(conversation) {
    messagesEl.querySelectorAll(".msg").forEach((n) => n.remove());
    const messages = conversation ? conversation.messages : [];
    emptyEl.hidden = messages.length > 0;
    for (const m of messages) messagesEl.appendChild(buildMessage(m));
    thinkStart = null;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    sync();
  }

  // Live card while the AI works. render() replaces it with the saved message.
  let liveNode = null, streamScroll = 0;
  function showThinking() {
    removeStatus();
    messagesEl.querySelectorAll(".msg-thinking").forEach((n) => n.remove());
    emptyEl.hidden = true;
    const node = buildMessage({ role: "assistant", text: "", live: true });
    node.classList.add("msg-thinking");
    liveNode = node;
    messagesEl.appendChild(node);
    thinkStart = Date.now();
    messagesEl.scrollTop = messagesEl.scrollHeight; // a new message always shows
    sync();
  }

  // Live status line BELOW the text container: tiny, dark grey, own font. Counter restarts from 1 on every phase change.
  let stopAnim = null;
  const endAnim = () => { if (stopAnim) { stopAnim(); stopAnim = null; } };
  let timer = null, statusNode = null, statusLabel = "";
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const iconRowOf = () => liveNode && liveNode.querySelector(".ai-listen-row");
  const removeStatus = () => { const r = iconRowOf(); if (r) r.style.top = "calc(100% + 2px)"; if (liveNode) { liveNode.style.paddingBottom = ""; const c = liveNode.querySelector(".ai-card"); if (c && c.querySelector(".ai-listen-row")) c.style.marginBottom = "32px"; } stopTimer(); if (statusNode) { statusNode.remove(); statusNode = null; } statusLabel = ""; };
  const labelOf = (s) => { s = String(s || ""); return /read|understand/i.test(s) ? "understanding the image" : /writ|feedback|formulat/i.test(s) ? "formulating response" : s.replace(/\s*·.*$/, ""); };
  function setStatus(label) {
    if (!liveNode || !liveNode.isConnected) return;
    if (!statusNode || !statusNode.isConnected) {
      statusNode = document.createElement("div");
      statusNode.className = "ai-status-line";
      statusNode.innerHTML = '<span class="ai-status-label"></span><span class="ai-status-time"></span>';
      const cardEl = liveNode.querySelector(".ai-card"); if (cardEl) cardEl.after(statusNode); else liveNode.append(statusNode); // directly under the card
      statusLabel = "";
      const r = iconRowOf(); if (r) r.style.top = "calc(100% + 30px)"; // progress text gets its own space; the icons sit below it
      liveNode.style.paddingBottom = "34px"; if (cardEl) cardEl.style.marginBottom = "0"; // status text sits right under the card, icons below it
    }
    if (label === statusLabel) return;
    statusLabel = label; // new phase: stop the old counter, count again from 1
    statusNode.querySelector(".ai-status-label").textContent = label;
    const timeEl = statusNode.querySelector(".ai-status-time"), t0 = Date.now();
    let shown = 0;
    const tickTime = () => { const n = Math.floor((Date.now() - t0) / 1000) + 1; if (n !== shown) { shown = n; timeEl.textContent = n + "s"; } };
    tickTime();
    stopTimer();
    timer = setInterval(tickTime, 250);
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  const clearDots = (el) => { endAnim(); if (el) { el.classList.remove("is-loading"); if (el.querySelector(".ai-anim,.ai-merge")) el.innerHTML = ""; } };
  function showStatus(stage) {
    const el = liveNode && liveNode.querySelector(".ai-resp-text");
    if (el && /^build\|/.test(String(stage))) { // image -> code builder: status + timer stay under the card the whole time, code keeps growing above it
      liveNode.dataset.build = "1";
      if (el.dataset.mode !== "stream" && !stopAnim) { el.classList.add("is-loading"); el.innerHTML = ""; stopAnim = startAnim(el); } // animation until the first code arrives
      setStatus(String(stage).slice(6)); // new step: the counter restarts from 1
      return;
    }
    if (!el || el.dataset.mode === "stream") return; // answer already streaming
    const label = labelOf(stage);
    if (/understanding/i.test(label)) { // image phase: three white dots in the card, timer + text below
      liveNode.dataset.image = "1";
      el.classList.add("is-loading");
      if (!stopAnim) { el.innerHTML = ""; stopAnim = startAnim(el); } // random animation, chosen once per image
      setStatus("reading the image"); // timer + text below the container
      return;
    }
    if (liveNode.dataset.image !== "1") return; // text-only message: stay empty and wait for the stream
    // image flows: the animation keeps playing until the first word of the answer arrives (no blank gap)
    setStatus(label);
  }

  // YOUR RESPONSE: shows the FINAL answer only, once generation has finished (replaces the loading indicator).
  function showAnswer(text) {
    if (!liveNode || !liveNode.isConnected) return;
    const el = liveNode.querySelector(".ai-resp-text");
    removeStatus(); endAnim(); el.dataset.mode = "stream";
    el.classList.remove("is-loading");
    el.textContent = text || "";
    tts.finalText("live", text);
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Real-time streaming: shows the text written so far inside YOUR RESPONSE (the glowing dot stays until the end).
  function streamAnswer(text) {
    if (!liveNode || !liveNode.isConnected) return;
    const el = liveNode.querySelector(".ai-resp-text");
    if (el.dataset.mode !== "stream") { el.dataset.mode = "stream"; clearDots(el); if (liveNode.dataset.build === "1") { /* keep the build status + timer */ } else if (liveNode.dataset.image === "1") setStatus("providing response"); else removeStatus(); }
    el.classList.remove("is-loading");
    el.style.opacity = "";
    text = text || "";
    tts.feed("live", text, false);
    if (!el._last || el._last.parentNode !== el || text.length < el._len) { el.textContent = ""; el._last = null; el._len = 0; }
    if (text.length > el._len) { const s = document.createElement("span"); s.className = "tok"; s.textContent = text.slice(el._len); el.append(s); el._last = s; el._len = text.length; } // only the new text is added; it fades in mildly (CSS), speed is unchanged
    if (!streamScroll) streamScroll = requestAnimationFrame(() => { streamScroll = 0; if (stick) messagesEl.scrollTop = messagesEl.scrollHeight; else sync(); });
  }

  // Ends the glowing dot cleanly; resolves when the animation is over (the caller then shows the saved message).
  function finish() {
    const node = liveNode;
    liveNode = null;
    removeStatus(); endAnim();
    if (!node || !node.isConnected) return Promise.resolve();
    const dot = node.querySelector(".ai-dot");
    if (dot) dot.classList.add("is-done");
    return Promise.resolve(); // no animation wait: the saved answer appears the moment generation ends
  }

  // Image Creator loading: a pure animation (no text) in the same small container the finished image will use.
  function showGenLoading() {
    removeStatus();
    emptyEl.hidden = true;
    const node = document.createElement("div");
    node.className = "msg msg-ai msg-thinking";
    const label = document.createElement("p"); label.className = "msg-label"; label.textContent = "FIDEX SI";
    const body = document.createElement("div"); body.className = "msg-body";
    const box = document.createElement("div"); box.className = "gen-loader"; box.setAttribute("role", "status"); box.setAttribute("aria-label", "Creating image");
    for (let i = 0; i < 3; i++) { const o = document.createElement("span"); o.className = "gen-orb gen-orb-" + (i + 1); box.append(o); }
    const grid = document.createElement("span"); grid.className = "gen-grid";
    const sweep = document.createElement("span"); sweep.className = "gen-sweep";
    box.append(grid, sweep);
    body.append(box); node.append(label, body);
    liveNode = node;
    messagesEl.appendChild(node);
    setStatus("generating your image"); // the same handwriting status line + timer as the image-reading phase, directly under the animation
    messagesEl.scrollTop = messagesEl.scrollHeight;
    sync();
  }

  // Stop: removes the live card at once (no animation delay).
  function discardLive() {
    const node = liveNode;
    liveNode = null;
    removeStatus(); endAnim();
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
    const image = attach ? attach.get() : null;
    if (!text && !image) return;
    if (imageMode && imageMode.on() && text) { inputEl.value = ""; autosize(); syncSend(); onSend(text, null, true); return; } // Image Creator: the text is the prompt
    if (attach && image) attach.take(); // the preview clears as the message leaves
    inputEl.value = "";
    autosize();
    syncSend();
    onSend(text || "What is in this image?", image);
  });

  // Offline voice input: fills the input only; the user still presses Send.
  let liveVs = { listening: false, speaking: false, processing: false };
  const micEl = formEl.querySelector("#chat-mic");
  if (micEl) {
    const prog = document.createElement("div");
    prog.id = "fx-voice-progress";
    formEl.appendChild(prog);
    let vs = liveVs;
    const paint = () => {
      const label = vs.speaking ? "speaking" : vs.processing ? "transcribing" : "";
      prog.textContent = label;
      prog.classList.toggle("on", !!label);
    };
    attachMic({
      micEl,
      onState: (s) => { vs = liveVs = s; paint(); },
      getText: () => inputEl.value,
      onText: (text) => {
        inputEl.value = text;
        autosize();
        syncSend();
        inputEl.scrollTop = inputEl.scrollHeight;
      },
    });
  }

  if (micEl) attachLive({ micEl, formEl, inputEl, sendEl, messagesEl, getVs: () => liveVs, isGenerating: () => generating });

  return { render, showThinking, showGenLoading, showStatus, showAnswer, streamAnswer, finish, discardLive, setGenerating, syncSend, focus: () => inputEl.focus() };
}
