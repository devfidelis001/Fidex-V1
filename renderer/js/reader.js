// Read aloud: tiny button under the response. Highlights the current word (white), click text to start from there.
let active = null; // { stop }

export function attachReader(wrap, textEl) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "read-mini";
  btn.title = "Read aloud";
  btn.setAttribute("aria-label", "Read aloud");
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  wrap.appendChild(btn);

  const hl = window.CSS && CSS.highlights ? new Highlight() : null;
  if (hl) CSS.highlights.set("reading-word", hl);
  let startAt = 0, speaking = false;

  function mark(s, e) {
    if (!hl) return;
    hl.clear();
    const node = textEl.firstChild;
    if (!node || node.nodeType !== 3) return;
    const r = new Range();
    r.setStart(node, Math.min(s, node.length));
    r.setEnd(node, Math.min(e, node.length));
    hl.add(r);
  }

  function stop() {
    speechSynthesis.cancel();
    speaking = false;
    if (hl) hl.clear();
    btn.classList.remove("on");
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
    if (active && active.stop === stop) active = null;
  }

  function play(from) {
    if (active) active.stop();
    const full = textEl.textContent || "";
    const text = full.slice(from);
    if (!text.trim()) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onboundary = (ev) => {
      if (ev.name && ev.name !== "word") return;
      let s = from + ev.charIndex;
      let e = ev.charLength ? s + ev.charLength : s + ((full.slice(s).match(/^\S+/) || [""])[0].length);
      mark(s, e);
    };
    u.onend = u.onerror = stop;
    active = { stop };
    speaking = true;
    btn.classList.add("on");
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>';
    speechSynthesis.speak(u);
  }

  btn.addEventListener("click", () => (speaking ? stop() : play(startAt)));

  // Click a word in the response to start (or continue) reading from there.
  textEl.style.cursor = "pointer";
  textEl.addEventListener("click", (e) => {
    if (String(getSelection())) return; // user is selecting text, don't interrupt
    let pos = null;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p && p.offsetNode === textEl.firstChild) pos = p.offset;
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r && r.startContainer === textEl.firstChild) pos = r.startOffset;
    }
    if (pos === null) return;
    const full = textEl.textContent;
    while (pos > 0 && /\S/.test(full[pos - 1])) pos--; // snap to word start
    startAt = pos;
    play(pos);
  });
}
