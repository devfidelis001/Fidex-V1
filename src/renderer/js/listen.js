// Listen button: offline Piper TTS (backend "synthesize_speech"), spoken incrementally from completed sentences.
// One global player: a new Listen click always stops the previous one (no overlap). Never touches generation.
import { bridge } from "./bridge.js";

const ICON = {
  spk: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  tick: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
};
const clean = (t) => String(t || "").replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/`([^`]*)`/g, "$1").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/^[#>\-*\s]+(?=\S)/gm, "").replace(/[*_#~|]/g, "").replace(/\s+/g, " ").trim();
const END = /([.!?]+["')\]]*)(\s)|\n/g;

const hl = window.CSS && CSS.highlights ? new Highlight() : { clear() {}, add() {} };
if (window.CSS && CSS.highlights) CSS.highlights.set("reading-word", hl);
function rangeFor(el, a, b) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, pos = 0, r = null;
  while ((n = w.nextNode())) {
    const len = n.length;
    if (!r && a < pos + len) { r = new Range(); r.setStart(n, Math.max(0, a - pos)); }
    if (r && b <= pos + len) { r.setEnd(n, Math.max(0, b - pos)); return r; }
    pos += len;
  }
  if (r && el.lastChild) { r.setEndAfter(el.lastChild); return r; }
  return null;
}
function offsetOf(el, node, off) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, pos = 0;
  while ((n = w.nextNode())) { if (n === node) return pos + off; pos += n.length; }
  return null;
}
let fillerEnd = 0; const fillerSrcs = new Set();
function stopFillers() { for (const f of fillerSrcs) { try { f.onended = null; f.stop(); } catch (e) {} } fillerSrcs.clear(); fillerEnd = 0; }
let S = null;
let rafOn = false;
function tick() {
  if (rafOn) return; rafOn = true;
  const loop = () => {
    if (!S || S.dead) { rafOn = false; hl.clear(); return; }
    if (actx && S.el) {
      const now = actx.currentTime; let cur = null;
      for (const it of S.items) { if (!it.words) continue; for (const w of it.words) { if (now >= w.t0 && now < w.t1) { cur = w; break; } } if (cur) break; }
      if (cur && cur !== S.cur) {
        const r = rangeFor(S.el, cur.a, cur.b);
        if (r) { S.cur = cur; hl.clear(); hl.add(r); }
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}            // the one active session
const buttons = new Set();
const folds = new Set();
const CHEV_UP = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
const CHEV_DOWN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
function paintFolds() {
  const h = document.body.classList.contains("fx-hide-text");
  for (const f of folds) { f.innerHTML = h ? CHEV_DOWN : CHEV_UP; f.title = h ? "Show all text" : "Hide all text"; f.setAttribute("aria-label", f.title); }
}
let actx = null;

function paintAll() {
  for (const b of buttons) {
    if (!b.el.isConnected) { buttons.delete(b); continue; }
    const mine = S && b.match(S);
    if (mine && b.textEl) S.el = b.textEl; // follow the saved card after the live one is replaced
    const st = mine ? S.state : "idle";
    b.main.innerHTML = mine && st !== "paused" ? ICON.pause : ICON.spk; // pause icon while reading
    b.main.title = mine ? (st === "paused" ? "Resume" : "Pause") : "Listen";
        b.stop.hidden = !mine;
    if (mine && S.err) b.main.title = "Speech failed: " + S.err;
  }
}

function endSession(s) {
  if (!s || s.dead) return;
  s.dead = true; clearTimeout(s.gate);
  hl.clear();
  for (const src of s.sources) { try { src.onended = null; src.stop(); } catch (e) {} }
  s.sources = [];
  if (S === s) { S = null; if (actx && actx.state === "suspended") actx.resume().catch(() => {}); }
  paintAll();
}

function nextChunk(s) {
  const raw = s.text; let from = s.pos;
  if (from >= raw.length) return null;
  for (;;) {
    END.lastIndex = from;
    const m = END.exec(raw);
    let end = -1;
    if (m) end = m.index + m[0].length;
    else if (s.final) end = raw.length;
    else { // still generating: speak whatever is already there, never wait for the end
      const tail = raw.slice(from);
      const first = s.items.length === 0; // the very first words are spoken as soon as they exist
      if (/[.!?]["')\]]*$/.test(tail) && clean(tail).length >= (first ? 14 : 20)) end = raw.length;
      else if (tail.length >= (first ? 28 : 60)) { const sp = raw.lastIndexOf(" "); end = sp > from + (first ? 16 : 40) ? sp + 1 : -1; } // cut before the unfinished last word
    }
    if (end < 0) return null;
    const buf = clean(raw.slice(s.pos, end));
    if (buf.length >= (s.items.length ? 20 : 14) || (s.final && end >= raw.length)) { s.rng = [s.pos, end]; s.pos = end; return buf; }
    if (end >= raw.length) return null; // short tail: wait for more text
    from = end; // short sentence: merge with the next one
  }
}

function pump(s) {
  if (s.dead) return;
  let c;
  while ((c = nextChunk(s))) { if (/[\p{L}\p{N}]/u.test(c)) s.items.push({ text: c, rng: s.rng, buf: null, done: false }); }
  // synthesize in order, max 2 at a time
  let active = s.items.filter((i) => i.busy && !i.done).length;
  for (const it of s.items) {
    if (active >= 3) break;
    if (it.busy || it.done) continue;
    it.busy = true; active++;
    synth(s, it);
  }
  schedule(s);
  if (s.final && !s.items.some((i) => !i.done || !i.played) && s.pos >= s.text.length && !s.sources.length && !s.dead) endSession(s);
}

async function synth(s, it) {
  try {
    const res = await bridge.backendRequest("synthesize_speech", { text: it.text });
    if (s.dead) return;
    if (!res || !res.ok) throw new Error((res && res.error && res.error.message) || "TTS unavailable");
    const bin = atob(res.data.audio_base64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    it.buf = await actx.decodeAudioData(u.buffer);
  } catch (e) {
    if (s.dead) return;
    console.error("[listen]", e);
    it.tries = (it.tries || 0) + 1;
    if (it.tries <= 60) { it.busy = false; setTimeout(() => pump(s), 1000); return; } // voice still loading: keep waiting and retry, never switch off
    s.err = String((e && e.message) || e);
    it.buf = null; it.skip = true;
    if (!s.items.some((i) => i.buf)) { endSession(s); return; }
  }
  it.done = true; it.doneAt = Date.now();
  pump(s);
}

function schedule(s) {
  if (s.dead) return;
  if (!s.started) { // do not start until the NEXT piece is ready too (or ~1.5 s passed), so the voice flows without a gap after the first words
    const a = s.items[0], b = s.items[1];
    const ready = a && a.done && ((b && b.done) || (s.final && s.items.every((i) => i.done)) || Date.now() - a.doneAt > 600); // never waits long: at most 0.6 s after the first piece is ready
    if (!ready) { if (!s.gate) s.gate = setTimeout(() => { s.gate = 0; pump(s); }, 250); return; }
    s.started = true;
  }
  while (s.next < s.items.length && s.items[s.next].done) { // strictly in order, back to back
    const it = s.items[s.next++];
    if (it.skip || !it.buf) { it.played = true; continue; }
    const src = actx.createBufferSource();
    src.buffer = it.buf; src.connect(actx.destination);
    const t = Math.max(actx.currentTime + 0.02, s.t, fillerEnd);
    src.start(t); s.t = t + it.buf.duration;
    it.words = [];
    if (it.rng) {
      const seg = s.text.slice(it.rng[0], it.rng[1]); const re = /\S+/g; let m, tot = 0; const ws = [];
      while ((m = re.exec(seg))) { const w = m[0].length + 2; ws.push([it.rng[0] + m.index, it.rng[0] + m.index + m[0].length, w]); tot += w; }
      let acc = 0;
      for (const [a, b, w] of ws) { it.words.push({ a, b, t0: t + it.buf.duration * acc / tot, t1: t + it.buf.duration * (acc + w) / tot }); acc += w; }
    }
    s.sources.push(src);
    if (s.state === "loading") s.state = "playing";
    src.onended = () => { it.played = true; s.sources = s.sources.filter((x) => x !== src); if (!s.dead && s.state !== "paused") pump(s); else if (!s.sources.length) pump(s); };
    paintAll();
  }
}

function start(key, text, final, match, from, el) {
  if (S) endSession(S);
  if (!actx || actx.state === "closed") actx = new AudioContext();
  actx.resume().catch(() => {});
  S = { t0: Date.now(), started: false, gate: 0, key, el, text: String(text || ""), final: !!final, pos: from || 0, items: [], next: 0, t: 0, sources: [], state: "loading", dead: false, err: "", match };
  paintAll();
  pump(S);
  tick();
  return S;
}

// Auto-speak: every new answer is read aloud from its first words, with no click needed.
let autoSeed = null, liveOn = false, lastFed = 0;
const autoMode = () => liveOn || document.body.classList.contains("fx-hide-text"); // live chat, or the wrap-up button pressed in normal chat
function autoStart(key, text, final) {
  text = String(text || "");
  const shrunk = text.length < lastFed; lastFed = text.length; if (shrunk) autoSeed = null; // text got shorter = a new answer began
  if (!autoMode() || key !== "live" || !clean(text)) return;
  if (autoSeed !== null && text.startsWith(autoSeed)) return; // same answer: already started (or stopped by the user)
  autoSeed = text;
  start(key, text, final, (s) => s.key === key, 0, null);
}

export const tts = {
  setLive(v) { liveOn = !!v; autoSeed = null; },
  resetAuto() { autoSeed = null; },
  // text arrives while the answer is being written (live card)
  feed(key, text, final) { autoStart(key, text, final); if (S && S.key === key && !S.dead) { S.text = String(text || ""); if (final) S.final = true; S.live = !final; pump(S); } },
  finalText(key, text) { autoStart(key, text, true); if (S && S.key === key && !S.dead) { S.text = String(text || ""); S.final = true; S.savedText = S.text.trim(); pump(S); } },
  stopAll() { stopFillers(); endSession(S); },
  ctx() { if (!actx || actx.state === "closed") actx = new AudioContext(); actx.resume().catch(() => {}); return actx; },
  hasAudio() { return !!(S && !S.dead && S.sources.length); },
  fillerActive() { return !!(actx && fillerEnd > actx.currentTime); },
  async clip(text) { // a short spoken line that is NOT part of any answer (used to keep the voice lively while waiting)
    const res = await bridge.backendRequest("synthesize_speech", { text });
    if (!res || !res.ok) throw new Error("TTS unavailable");
    const bin = atob(res.data.audio_base64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return tts.ctx().decodeAudioData(u.buffer);
  },
  playClip(buf) {
    const a = tts.ctx(); const src = a.createBufferSource(); src.buffer = buf; src.connect(a.destination);
    const t = Math.max(a.currentTime + 0.02, fillerEnd); src.start(t); fillerEnd = t + buf.duration;
    fillerSrcs.add(src); src.onended = () => fillerSrcs.delete(src);
  },
  warm() { // power the voice on at launch: audio engine, Piper voice and mic permission are ready before the first click
    try { if (!actx || actx.state === "closed") actx = new AudioContext(); } catch (e) {}
    const tryWarm = (n) => { try { bridge.backendRequest("synthesize_speech", { text: "Ready." }).then((r) => { if (!(r && r.ok) && n < 120) setTimeout(() => tryWarm(n + 1), 1500); }).catch(() => { if (n < 30) setTimeout(() => tryWarm(n + 1), 1500); }); } catch (e) {} };
    tryWarm(0); // keeps trying until the backend is up, so the voice is loaded before the first answer
    try { navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop())).catch(() => {}); } catch (e) {}
  },
  isActive() { return !!(S && !S.dead); },
};

// Builds the small control row (speaker = Listen/Pause/Resume, square = Stop).
export function createListenButton({ key, getText, isFinal, textEl }) {
  const el = document.createElement("div");
  el.className = "tts-row";
  const main = document.createElement("button"); main.type = "button"; main.className = "tts-btn"; main.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;margin:0;border:0;border-radius:0;background:none;box-shadow:none;outline:none;color:#cfcfcf;opacity:.8;cursor:pointer;line-height:0"; main.innerHTML = ICON.spk; main.title = "Listen"; main.setAttribute("aria-label", "Listen");
  const stop = { hidden: true };
  const fold = document.createElement("button"); fold.type = "button"; fold.className = "tts-btn"; fold.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;margin:0;border:0;border-radius:0;background:none;box-shadow:none;outline:none;color:#cfcfcf;opacity:.8;cursor:pointer;line-height:0";
  folds.add(fold);
  fold.addEventListener("click", () => { for (const f of folds) if (!f.isConnected) folds.delete(f); document.body.classList.toggle("fx-hide-text"); paintFolds();
    if (document.body.classList.contains("fx-hide-text") && !(S && !S.dead) && String(getText()).trim()) { autoSeed = String(getText()); start(key, getText(), isFinal(), match, 0, textEl); } // wrap up = read this answer now (and every new one from its first words)
  });
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "tts-btn"; copy.style.cssText = main.style.cssText; copy.innerHTML = ICON.copy; copy.title = "Copy response"; copy.setAttribute("aria-label", "Copy response");
  copy.addEventListener("click", async (e) => {
    e.stopPropagation();
    const t = String((textEl && textEl.textContent) || getText() || "").trim(); if (!t) return;
    try { await navigator.clipboard.writeText(t); } catch (err) { const ta = document.createElement("textarea"); ta.value = t; ta.style.cssText = "position:fixed;opacity:0"; document.body.append(ta); ta.select(); try { document.execCommand("copy"); } catch (e2) {} ta.remove(); }
    copy.innerHTML = ICON.tick; setTimeout(() => { copy.innerHTML = ICON.copy; }, 1500);
  });
  el.append(main, fold, copy); paintFolds();
  const match = (s) => s.key === key || (!!s.savedText && s.savedText === String(getText()).trim());
  buttons.add({ el, main, stop, match, textEl });
  main.addEventListener("click", () => {
    if (S && match(S) && !S.dead) { // reading: pause / resume
      if (S.state === "paused") { S.state = "playing"; actx.resume().catch(() => {}); } else { S.state = "paused"; actx.suspend().catch(() => {}); }
      paintAll(); return;
    }
    start(key, getText(), isFinal(), match, 0, textEl);
  });
  if (textEl) {
    textEl.style.cursor = "pointer";
    textEl.addEventListener("mouseup", (e) => {
      if (String(getSelection())) return;
      let node = null, pos = null;
      if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(e.clientX, e.clientY); if (p) { node = p.offsetNode; pos = p.offset; } }
      else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(e.clientX, e.clientY); if (r) { node = r.startContainer; pos = r.startOffset; } }
      if (!node || !textEl.contains(node)) return;
      pos = offsetOf(textEl, node, pos);
      if (pos === null) return;
      const full = textEl.textContent;
      while (pos > 0 && /\S/.test(full[pos - 1])) pos--;
      start(key, getText(), isFinal(), match, pos, textEl);
    });
  }
  return el;
}

// Power the voice on the moment the app opens.
{ const w = window.fidex && window.fidex.chatWake; (typeof w === "function" ? Promise.resolve(w()).catch(() => {}) : Promise.resolve()).then(() => setTimeout(() => tts.warm(), 300)); } // voice loads after the brain is ready

// Sound unlock: browsers keep audio muted until the user interacts. Resume on every interaction until it is running.
for (const ev of ["pointerdown", "keydown", "touchstart", "click", "mousedown"]) {
  document.addEventListener(ev, () => { try { if (!actx || actx.state === "closed") actx = new AudioContext(); if (actx.state !== "running" && !(S && !S.dead && S.state === "paused")) actx.resume().catch(() => {}); } catch (e) {} }, { capture: true });
}
