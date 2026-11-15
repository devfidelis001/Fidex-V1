// Offline live speech-to-text for the chat input. Click mic = start, click again = stop.
// Audio is split into phrases by an adaptive voice detector. The current phrase is re-transcribed
// every ~300 ms by the local Whisper runtime ("transcribe_audio") and streamed into the input;
// when you pause, the phrase is committed and a new one starts. Stop is instant: anything still
// being transcribed is discarded. The mic button pulses with your voice level. Never auto-sends.

import { bridge } from "./bridge.js";

const MIN_VOICE_RMS = 0.004;  // absolute floor: below this is never speech (works with quiet mics)
const NOISE_MULT = 2.5;       // speech must be this many times louder than the room noise
const END_SILENCE_MS = 420;   // quiet time that ends a phrase
const PREROLL_MS = 200;       // keep a little audio before speech starts
const MAX_PHRASE_SECONDS = 8;
const TICK_MS = 40;           // check for new audio very often; a request goes out the instant the last one returns
const NO_SPEECH_HINT_MS = 4000;

function wav16k(samples, rate) {
  const ratio = rate / 16000;
  const n = Math.max(1, Math.floor(samples.length / ratio));
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true);
  out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, n * 2, true);
  // normalise quiet recordings so Whisper always gets a usable level
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  const gain = peak > 0 ? Math.min(8, Math.max(1, 0.7 / peak)) : 1;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), e = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = a; j < e; j++) sum += samples[j];
    const v = Math.max(-1, Math.min(1, (sum / (e - a)) * gain));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out.buffer;
}
function b64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const join = (a, b) => (a && b && !/\s$/.test(a) ? a + " " : a) + b;

// Power the ears on at launch: loads the local Whisper model in the backend before the first mic click (keeps retrying until the backend is up).
// Only the speech engine is warmed. The microphone itself stays closed until the user clicks, so no recording indicator shows at launch.
export function warmEars() {
  const rate = 16000, n = rate * 0.6, a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (Math.random() - 0.5) * 0.02; // faint noise so the backend really runs the model
  const audio_base64 = b64(wav16k(a, rate));
  const tryWarm = (k) => { const again = () => { if (k < 120) setTimeout(() => tryWarm(k + 1), 1500); };
    try { bridge.backendRequest("transcribe_audio", { audio_base64, format: "wav", sample_rate: 16000, language: (localStorage.getItem("fidex_stt_lang") || "en"), final: false }).then((r) => { if (!(r && r.ok)) again(); }).catch(again); } catch (e) { again(); } };
  tryWarm(0);
}
// The speech engine loads only after the brain is ready, so it never competes with the brain for CPU while it turns on.
{ const w = window.fidex && window.fidex.chatWake; (typeof w === "function" ? Promise.resolve(w()).catch(() => {}) : Promise.resolve()).then(() => setTimeout(warmEars, 300)); }

export function attachMic({ micEl, getText, onText, onCommit, onState }) {
  const form = micEl.closest("form");
  form.style.position = "relative";
  const bar = document.createElement("div");
  bar.id = "fx-mic-status";
  form.appendChild(bar);
  let hideT = null;
  const show = (kind, text, ms) => {
    clearTimeout(hideT);
    if (kind === "rec") return; // no "Listening…" red-dot bar
    bar.className = "on " + kind;
    bar.innerHTML = "<i></i><span></span>";
    bar.lastChild.textContent = text;
    if (ms) hideT = setTimeout(() => (bar.className = ""), ms);
  };
  const hide = () => { clearTimeout(hideT); bar.className = ""; };

  let stream = null, actx = null, proc = null, mute = null, listening = false, starting = false, timer = null, hintT = null, noSpeechT = null;
  let sid = 0, inflight = false, cancelled = false;
  let base = "", partial = "";          // committed text, text of the phrase being spoken
  let phrase = [], preroll = [];        // audio of the current phrase / recent quiet audio
  let speaking = false, quiet = 0, voiced = 0, heardAny = false, gotAudio = false;
  let noise = 0.003, lvl = 0;           // running room-noise estimate, smoothed level for the animation
  let finalizing = false;
  let lastSt = "";
  const emit = () => { if (!onState) return; const st = { listening, speaking, processing: inflight || finalizing }; const k = JSON.stringify(st); if (k !== lastSt) { lastSt = k; onState(st); } };
  let dirty = false, partialLen = 0;    // new audio since last transcription / samples covered by `partial`

  function setOn(on) {
    micEl.classList.toggle("is-recording", on);
    if (!on) { micEl.classList.remove("quiet"); micEl.style.removeProperty("--lvl"); }
    micEl.setAttribute("aria-label", on ? "Stop recording" : "Start voice input");
    micEl.title = on ? "Listening — click to stop" : "Voice input (offline)";
  }

  function onChunk(buf) {
    gotAudio = true;
    const c = new Float32Array(buf);
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * c[i];
    const rms = Math.sqrt(s / c.length);

    // button animation: grows with the voice
    const target = Math.min(1, rms * 14);
    lvl = target > lvl ? target : lvl * 0.8 + target * 0.2;
    micEl.style.setProperty("--lvl", lvl.toFixed(3));
    micEl.classList.toggle("quiet", lvl < 0.04);

    const loud = rms > Math.max(MIN_VOICE_RMS, noise * NOISE_MULT);
    if (!loud) noise = noise * 0.95 + rms * 0.05; // learn the room noise from quiet chunks only
    if (loud) {
      if (!heardAny) { heardAny = true; hide(); show("rec", "Listening…"); }
      if (!speaking) { speaking = true; phrase = preroll.slice(); preroll = []; voiced = 0; emit(); }
      voiced++; quiet = 0; dirty = true;
      phrase.push(c);
    } else if (speaking) {
      quiet++; phrase.push(c);
    } else {
      preroll.push(c);
      if (preroll.length * 1000 * c.length / actx.sampleRate > PREROLL_MS) preroll.shift();
    }
  }

  function flat(parts) {
    let len = 0;
    for (const c of parts) len += c.length;
    const all = new Float32Array(len);
    let o = 0;
    for (const c of parts) { all.set(c, o); o += c.length; }
    return all;
  }

  async function tick() {
    if (!listening || inflight || !speaking) return;
    const rate = actx.sampleRate;
    const total = phrase.reduce((n, c) => n + c.length, 0);
    const commit = quiet * 1000 * (phrase[0] ? phrase[0].length : 1024) / rate >= END_SILENCE_MS || total > rate * MAX_PHRASE_SECONDS;
    if (!commit && !dirty) return;
    if (voiced < 1 && !commit) return; // ignore clicks/pops
    const my = sid;
    const data = flat(phrase);
    if (commit) { phrase = []; speaking = false; quiet = 0; emit(); }
    dirty = false;

    // Nothing new since the last partial: commit it without another Whisper run.
    if (commit && partial && data.length === partialLen) { const t = join(base, partial); base = ""; partial = ""; partialLen = 0; send(t); return; }
    if (voiced < 1 || data.length < rate * 0.2) { if (commit) { partial = ""; partialLen = 0; } return; }

    inflight = true; emit();
    try {
      const res = await bridge.backendRequest("transcribe_audio", { audio_base64: b64(wav16k(data, rate)), format: "wav", sample_rate: 16000, language: (localStorage.getItem("fidex_stt_lang") || "en"), final: false });
      if (my !== sid) return; // stopped meanwhile: discard
      if (!res.ok) {
        show("err", "Transcription failed: " + ((res.error && res.error.message) || "unknown error"), 8000);
        stop(true);
        return;
      }
      const text = String((res.data && res.data.text) || "").trim();
      if (commit) {
        const t = join(base, text || partial);
        if (!text && !partial) show("err", "No speech detected.", 2500);
        base = ""; partial = ""; partialLen = 0;
        send(t);
      } else if (text) {
        partial = text; partialLen = data.length;
        onText(join(base, partial));
      }
    } finally {
      if (my === sid) inflight = false;
      emit();
    }
  }

  function send(t) { base = String(t || "").trim(); onText(base); } // writes into the input only, never sends

  async function start() {
    if (starting || listening) return;
    starting = true; cancelled = false;
    setOn(true); micEl.classList.add("quiet"); // the button turns on the instant it is clicked; the device opens right behind it
    // Create and resume the AudioContext inside the click so it is never left suspended (silent capture).
    actx = new AudioContext({ latencyHint: "interactive" });
    actx.resume().catch(() => {});
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    } catch (e) {
      actx.close().catch(() => {});
      actx = null;
      starting = false;
      setOn(false);
      const n = e && e.name;
      show("err", n === "NotFoundError" || n === "OverconstrainedError" ? "No microphone found. Plug one in or pick an input device in system settings." : n === "NotReadableError" ? "Microphone is busy in another app." : "Microphone permission denied. Allow it in system privacy settings.", 7000);
      return;
    }
    if (cancelled) { // clicked again before the device opened: release it at once
      stream.getTracks().forEach((t) => t.stop()); actx.close().catch(() => {}); actx = stream = null; starting = false; setOn(false); return;
    }
    try { await actx.resume(); } catch (e) {}
    stream.getAudioTracks().forEach((t) => { t.onended = () => { if (listening) { show("err", "The microphone was disconnected.", 5000); stop(true); } }; });
    const src = actx.createMediaStreamSource(stream);
    proc = actx.createScriptProcessor(1024, 1, 1);
    proc.onaudioprocess = (e) => onChunk(e.inputBuffer.getChannelData(0));
    mute = actx.createGain();
    mute.gain.value = 0; // keeps the processor running without playing the mic through the speakers
    src.connect(proc);
    proc.connect(mute);
    mute.connect(actx.destination);
    sid++;
    inflight = false;
    base = getText(); partial = ""; partialLen = 0;
    phrase = []; preroll = []; speaking = false; quiet = 0; voiced = 0; heardAny = false; gotAudio = false; dirty = false;
    noise = 0.003; lvl = 0;
    listening = true;
    starting = false; emit();
    setOn(true);
    micEl.classList.add("quiet");
    show("rec", "Listening… speak now (click the mic to stop)");
    timer = setInterval(tick, TICK_MS);
    clearTimeout(hintT); clearTimeout(noSpeechT);
    // No frames at all = mic delivers nothing; frames but no voice = "No speech detected".
    hintT = setTimeout(() => { if (listening && !gotAudio) show("err", "No audio from the microphone. Check the selected input device.", 6000); }, 2500);
    noSpeechT = setTimeout(() => { if (listening && gotAudio && !heardAny) show("err", "No speech detected. Speak closer to the mic.", 0); }, NO_SPEECH_HINT_MS);
  }

  async function stop(silent) {
    if (!listening) return;
    listening = false;
    const rate = actx ? actx.sampleRate : 48000;
    const leftover = speaking && voiced >= 1 ? flat(phrase) : null;
    const hadPartial = partial, pBase = base;
    speaking = false; phrase = []; preroll = [];
    clearInterval(timer); clearTimeout(hintT); clearTimeout(noSpeechT);
    setOn(false);
    stream && stream.getTracks().forEach((t) => t.stop());
    try { proc.disconnect(); mute.disconnect(); } catch (e) {}
    actx && actx.close().catch(() => {});
    actx = stream = proc = mute = null;
    if (!silent) { if (!heardAny) show("err", "No speech detected.", 2500); else hide(); }
    finalizing = true; emit();
    try {
      while (inflight) await new Promise((r) => setTimeout(r, 20)); // let a phrase already being transcribed finish
      const b = base; // may have been committed meanwhile
      if (leftover && hadPartial && leftover.length - partialLen < rate * 0.35) send(join(b, hadPartial));
      else if (leftover && leftover.length >= rate * 0.2) {
        let text = "";
        try {
          const res = await bridge.backendRequest("transcribe_audio", { audio_base64: b64(wav16k(leftover, rate)), format: "wav", sample_rate: 16000, language: (localStorage.getItem("fidex_stt_lang") || "en"), final: true });
          if (res.ok) text = String((res.data && res.data.text) || "").trim();
        } catch (e) {}
        send(join(b, text || hadPartial));
      } else if (b || hadPartial) send(join(b, hadPartial));
      partial = "";
    } finally { finalizing = false; emit(); }
  }

  micEl.addEventListener("click", () => {
    if (listening) stop(false);
    else if (starting) { cancelled = true; setOn(false); } // second click while the device is still opening = cancel
    else start();
  });
}
