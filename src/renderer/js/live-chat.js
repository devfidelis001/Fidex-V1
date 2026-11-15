// Live voice chat: turn on once, then just talk. Hears you (mic), auto-sends after you pause, the answer shows and is read
// aloud as it is generated. Speaking while the AI answers stops it and starts a new turn. While you wait, short spoken
// lines ("let me think...") keep it lively; they are separate from the answer.
import { tts } from "./listen.js";
import { bridge } from "./bridge.js";

const norm = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

const LINES = {
  think: ["Hmm, let me think.", "Uummm, let me think about that.", "Let me think for a second."],
  action: ["Okayyy, let me do that now.", "Sure, let me check.", "Okay, let me look into that."],
  wait: ["Just a second.", "Wait a second.", "One moment."],
  more: ["Still on it, just a little longer.", "Almost there."],
};
const ACTION = /\b(search|find|look|check|create|make|build|generate|write|draft|calculate|compute|open|show|send|plan|list|summari[sz]e|translate|fix|solve|research|analy[sz]e|compare|give me|tell me about|prepare|design)\b/;
const THINK = /^(why|how|what|which|who|explain|should|could|would|is it|are there|do you think|can you explain|what's|whats)\b/;
const SMALL = /^(hi|hello|hey|yo|hiya|thanks|thank you|ok|okay|yes|no|yeah|nope|bye|cool|nice|good (morning|afternoon|evening|night)|how are you|what's up|whats up|sup)\b/;

// Decides if (and what kind of) waiting line fits the request. Greetings and tiny messages get none.
function intent(text) {
  const t = String(text || "").toLowerCase().trim(), n = norm(t).length;
  if (n === 0) return null;
  if (n <= 3 && SMALL.test(t)) return null;
  if (ACTION.test(t)) return "action";
  if (THINK.test(t) && n >= 4) return "think";
  if (n >= 2) return "wait";
  return null;
}

// The recognizer can repeat itself; drop sentences that were already said.
function dedupe(text) {
  const parts = String(text).match(/[^.!?]+[.!?]*/g) || [text], seen = new Set(), out = [];
  for (const p of parts) { const k = norm(p).join(" "); if (!k || seen.has(k)) continue; seen.add(k); out.push(p.trim()); }
  return out.join(" ");
}


function wav16k(samples, rate) {
  const ratio = rate / 16000;
  const n = Math.max(1, Math.floor(samples.length / ratio));
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true);
  out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), e = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0; for (let j = a; j < e; j++) sum += samples[j];
    const v = Math.max(-1, Math.min(1, (sum / (e - a)) * 3));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out.buffer;
}
function b64(buf) {
  const b = new Uint8Array(buf); let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function attachLive({ micEl, formEl, inputEl, sendEl, messagesEl, getVs, isGenerating }) {
  const live = document.createElement("button");
  live.type = "button"; live.id = "live-chat"; live.className = "round-btn"; live.title = "Live voice chat"; live.setAttribute("aria-label", "Live voice chat");
  live.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>';
  micEl.after(live);
  const prog = formEl.querySelector("#fx-voice-progress");

  let on = false, timer = null, ear = null, utt = null, uttSamples = 0, pre = [];
  let floor = 0.002, speechMs = 0, silenceMs = 0, talking = false, lastBarge = 0;
  let pending = "", transcribing = 0, fillerT = null, fillerT2 = null, lastLine = "";
  const clips = { think: [], action: [], wait: [], more: [] };
  let clipsLoading = false;
  let sentAt = 0;
  // Preparing = a message was sent and the first word of the answer has not appeared yet. The mic is off during it.
  const firstWord = () => { const el = messagesEl.querySelector(".msg-thinking .ai-resp-text"); return !!el && (!!el.querySelector(".tok") || (!el.querySelector(".ai-anim,.ai-merge") && el.textContent.trim().length > 0)); };
  const preparing = () => (isGenerating() || Date.now() - sentAt < 800) && !firstWord();
  let lastChk = 0, checking = false, uid = 0, spec = null, lastTick = 0;
  let aiWas = false, aiStart = 0, aiEnd = 0, echoLvl = 0, uttBusy = false;

  const aiText = () => { const els = messagesEl.querySelectorAll(".msg-ai .ai-resp-text"); return els.length ? els[els.length - 1].textContent : ""; };
  const isEcho = (heard) => {
    const h = norm(heard); if (!h.length) return false;
    const a = new Set(norm(aiText()));
    return h.filter((w) => a.has(w)).length / h.length >= 0.5;
  };

  // ---- the ear: always listening, separate from the mic button, so nothing is missed while a message is being transcribed or sent
  let earStarting = false;
  async function startEar() {
    if (earStarting || ear) return;
    earStarting = true;
    const ac = new AudioContext(); ac.resume().catch(() => {}); // created inside the click so it is never left suspended
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true } });
      ac.resume().catch(() => {});
      if (!on) { st.getTracks().forEach((t) => t.stop()); ac.close().catch(() => {}); earStarting = false; return; }
      const src = ac.createMediaStreamSource(st), an = ac.createAnalyser(), proc = ac.createScriptProcessor(1024, 1, 1), mute = ac.createGain();
      an.fftSize = 1024; mute.gain.value = 0;
      src.connect(an); src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
      proc.onaudioprocess = (e) => {
        const f = new Float32Array(e.inputBuffer.getChannelData(0));
        if (utt) { utt.push(f); uttSamples += f.length; } else { pre.push(f); if (pre.length > 10) pre.shift(); }
      };
      ear = { st, ac, an, proc, buf: new Float32Array(an.fftSize), fb: new Uint8Array(an.frequencyBinCount) };
    } catch (e) { ear = null; ac.close().catch(() => {}); console.error("[live] mic unavailable", e); }
    earStarting = false;
  }
  function stopEar() {
    if (!ear) return;
    try { ear.proc.disconnect(); } catch (e) {}
    ear.st.getTracks().forEach((t) => t.stop());
    ear.ac.close().catch(() => {});
    ear = null; utt = null; pre = [];
  }
  // Plain ear: no band filter, no loudness gate beyond a tiny adaptive floor, so quiet speech is heard.
  function sense() {
    if (!ear) return false;
    const { an, buf } = ear;
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const lvl = Math.sqrt(sum / buf.length), now = Date.now();
    const ai = tts.isActive() || tts.fillerActive();
    if (ai && !aiWas) { aiStart = now; echoLvl = 0; }
    if (!ai && aiWas) aiEnd = now;
    aiWas = ai;
    if (ai) { // the AI is speaking: learn how loud its own voice is in the mic, and only accept a clearly louder, sustained voice
      if (now - aiStart < 600) { echoLvl = Math.max(echoLvl * 0.98, lvl); return false; }
      const thr = Math.max(0.03, echoLvl * 2.4);
      if (lvl <= thr) { echoLvl = echoLvl * 0.9 + lvl * 0.1; return false; }
      return true;
    }
    if (now - aiEnd < 450) return false; // room tail right after the AI stops
    const voice = lvl > Math.max(0.003, floor * 2);
    if (!voice) floor = Math.min(0.01, floor * 0.95 + lvl * 0.05);
    return voice;
  }

  function bargeIn() {
    lastBarge = Date.now();
    clearTimeout(fillerT); clearTimeout(fillerT2);
    if (isGenerating()) sendEl.click(); // stop generating
    tts.stopAll();                       // stop talking
  }

  // The utterance is transcribed in the background; the ear is already listening again.
  async function finishUtterance() {
    if (!utt || !ear) return;
    const rate = ear.ac.sampleRate;
    const first = utt; const sp = spec && spec.id === uid ? spec : null; const fullN = uttSamples; utt = null; uttSamples = 0; lastChk = 0; uid++; spec = null;
    let len = 0; for (const c of first) len += c.length;
    if (len < rate * 0.25) return;
    const data = new Float32Array(len); let o = 0; for (const c of first) { data.set(c, o); o += c.length; }
    const wasBusy = uttBusy || isGenerating() || tts.isActive() || tts.fillerActive(); uttBusy = false;
    transcribing++;
    try {
      let text;
      if (sp && sp.text && fullN - sp.n < rate * 0.3) text = sp.text; // nothing new since the live partial: use it instantly
      else {
        const res = await bridge.backendRequest("transcribe_audio", { audio_base64: b64(wav16k(data, rate)), format: "wav", sample_rate: 16000, language: (localStorage.getItem("fidex_stt_lang") || "en"), final: true });
        text = String((res && res.ok && res.data && res.data.text) || "").trim();
      }
      if (text && /[\p{L}\p{N}]/u.test(text) && !(wasBusy && isEcho(text)) && !preparing()) {
        if (isGenerating() || tts.isActive() || tts.fillerActive()) bargeIn(); // new speech is transcribed: stop the old answer, then send the new one
        pending = (pending ? pending + " " : "") + text;
      }
    } catch (e) { console.error("[live] transcription failed", e); }
    transcribing--;
  }

  // While the AI is busy and you keep talking: transcribe what you have so far; the moment it is real speech (not the AI's own voice) the old answer stops.
  async function earlyCheck() {
    if (checking || !utt || !ear) return;
    checking = true; lastChk = uttSamples; const myId = uid, myN = uttSamples;
    const rate = ear.ac.sampleRate; let len = 0; for (const c of utt) len += c.length;
    const data = new Float32Array(len); let o = 0; for (const c of utt) { data.set(c, o); o += c.length; }
    try {
      const res = await bridge.backendRequest("transcribe_audio", { audio_base64: b64(wav16k(data, rate)), format: "wav", sample_rate: 16000, language: (localStorage.getItem("fidex_stt_lang") || "en"), final: false });
      const text = String((res && res.ok && res.data && res.data.text) || "").trim();
      if (myId === uid) spec = { id: myId, text, n: myN };
      if (on && text && /[\p{L}\p{N}]/u.test(text) && !isEcho(text) && !preparing() && (isGenerating() || tts.isActive() || tts.fillerActive())) bargeIn();
    } catch (e) { console.error("[live] early check failed", e); }
    checking = false;
  }

  // ---- waiting lines
  async function loadClips() {
    if (clipsLoading) return; clipsLoading = true;
    for (let i = 0; i < 3; i++) {
      for (const k of Object.keys(LINES)) {
        const line = LINES[k][i]; if (!line || clips[k].some((c) => c.line === line)) continue;
        try { clips[k].push({ line, buf: await tts.clip(line) }); } catch (e) { console.error("[live] line failed", e); clipsLoading = false; if (on) setTimeout(loadClips, 2500); return; }
      }
    }
  }
  function say(kind) {
    const pool = clips[kind].filter((c) => c.line !== lastLine);
    if (!pool.length) { loadClips(); return false; }
    const c = pool[Math.floor(Math.random() * pool.length)];
    lastLine = c.line; tts.playClip(c.buf); return true;
  }
  function armFiller(text) {
    clearTimeout(fillerT); clearTimeout(fillerT2);
    const kind = intent(text);
    if (!kind) return;
    const tryLine = (k, n) => { if (!on || !preparing()) return; if (!say(k) && n < 20) fillerT = setTimeout(() => tryLine(k, n + 1), 400); };
    fillerT = setTimeout(() => tryLine(kind, 0), 300);
    fillerT2 = setTimeout(() => { if (on && preparing()) say("more"); }, 7000);
  }
  formEl.addEventListener("submit", () => { if (on) { tts.resetAuto(); sentAt = Date.now(); armFiller(inputEl.value); } }, true);

  function tick() {
    if (!on) return;
    const nowT = Date.now(), dt = lastTick ? Math.min(250, nowT - lastTick) : 40; lastTick = nowT;
    autoRead(); // fallback: the reader starts the moment the answer card exists, so the first words are spoken as they appear
    if (!ear) startEar(); else if (ear.ac.state === "suspended") ear.ac.resume().catch(() => {}); // the ear must never stay off
    const gen = isGenerating(), busy = gen || tts.isActive() || tts.fillerActive(), now = Date.now();
    if (preparing()) { // mic is off until the first word of the answer appears
      talking = false; speechMs = silenceMs = 0; utt = null; uttSamples = 0; pre = [];
      if (prog) { prog.textContent = "giving response"; prog.classList.add("on"); }
      return;
    }
    const voice = sense();
    if (voice) { speechMs += dt; silenceMs = 0; if (speechMs >= (busy ? 250 : 60) && !talking) { talking = true; if (!utt) { utt = pre.splice(0); uttSamples = 0; lastChk = 0; } } }
    else { silenceMs += dt; if (!talking) speechMs = 0; }
    if (talking && busy) uttBusy = true;
    if (talking && utt && ear && !checking && uttSamples - lastChk > ear.ac.sampleRate * 0.35) earlyCheck(); // speculative live partials while you speak
    const tooLong = utt && ear && uttSamples > ear.ac.sampleRate * 10; // keep requests small
    if (talking && (silenceMs >= 380 || tooLong)) { // you stopped talking: transcribe in the background, keep listening
      talking = tooLong ? talking : false; speechMs = 0;
      finishUtterance();
      if (tooLong) utt = [];
    }
    if (prog) { const label = talking && transcribing ? "listening and transcribing" : talking ? "listening" : transcribing ? "transcribing" : ear ? "listening" : ""; prog.textContent = label; prog.classList.toggle("on", !!label); }
    if (pending && !gen && !transcribing) { // send automatically, once the AI is no longer generating
      const text = dedupe(pending); pending = "";
      inputEl.value = text; inputEl.dispatchEvent(new Event("input"));
      formEl.requestSubmit();
    }
  }

  // The answer is read the moment it starts generating.
  const autoRead = () => {
    return; // silent until the Listen button is clicked
    const n = messagesEl.querySelector(".msg-thinking:not([data-auto])"), b = n && n.querySelector(".tts-btn");
    if (b) { n.dataset.auto = "1"; if (tts.isActive()) tts.stopAll(); b.click(); } // only the Listen button, once per answer
  };
  const obs = new MutationObserver(() => autoRead()); // always on: typed messages are read aloud too, from the first words
  obs.observe(messagesEl, { childList: true, subtree: true });

  function setOn(v) {
    on = v; tts.setLive(on);
    live.classList.toggle("is-on", on);
    document.body.classList.toggle("fx-live", on);
    let st = document.getElementById("fx-live-style"); if (!st) { st = document.createElement("style"); st.id = "fx-live-style"; st.textContent = "body.fx-live .tts-row .tts-btn{display:none!important}"; document.head.append(st); } // voice cannot be turned off in live mode
    inputEl.classList.toggle("fx-live-input", on);
    if (on) { pending = ""; talking = false; speechMs = silenceMs = 0; startEar(); loadClips(); timer = setInterval(tick, 40); lastTick = 0; }
    else {
      clearInterval(timer); timer = null; clearTimeout(fillerT); clearTimeout(fillerT2); stopEar();
      if (prog) { prog.textContent = ""; prog.classList.remove("on"); }
      tts.stopAll();
    }
  }
  live.addEventListener("click", () => setOn(!on));
  setTimeout(loadClips, 2500); // waiting lines are prepared at start-up, so the first one is ready the first time you send
}
