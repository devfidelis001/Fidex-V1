// Offline live speech-to-text for the chat input. Click mic = start, click again = stop.
// While listening, audio is re-transcribed every ~2.5 s by the local Whisper runtime (backend
// request "transcribe_audio") and the text is written live into the input. Never auto-sends.

import { bridge } from "./bridge.js";



const SEGMENT_SECONDS = 8;

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
    let sum = 0;
    for (let j = a; j < e; j++) sum += samples[j];
    const v = Math.max(-1, Math.min(1, (sum / (e - a)) * 1.5));
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

export function attachMic({ micEl, getText, onText }) {
  const form = micEl.closest("form");
  form.style.position = "relative";
  const bar = document.createElement("div");
  bar.id = "fx-mic-status";
  form.appendChild(bar);
  let hideT = null;
  const show = (kind, text, ms) => {
    clearTimeout(hideT);
    bar.className = "on " + kind;
    bar.innerHTML = "<i></i><span></span>";
    bar.lastChild.textContent = text;
    if (ms) hideT = setTimeout(() => (bar.className = ""), ms);
  };

  let stream = null, actx = null, proc = null, chunks = [], listening = false, inflight = false, timer = null, base = "", startBase = "", lastText = "", failed = false;

  function setOn(on) {
    micEl.classList.toggle("is-recording", on);
    micEl.setAttribute("aria-label", on ? "Stop recording" : "Start voice input");
    micEl.title = on ? "Listening — click to stop" : "Voice input (offline)";
  }

  function samples(count) {
    const part = chunks.slice(0, count);
    let len = 0;
    for (const c of part) len += c.length;
    const all = new Float32Array(len);
    let o = 0;
    for (const c of part) { all.set(c, o); o += c.length; }
    return all;
  }

  async function transcribe(final) {
    if (inflight || !chunks.length || !actx) return;
    inflight = true;
    try {
      const n = chunks.length; // chunks may keep arriving while Whisper runs
      const data = samples(n);
      const rate = actx.sampleRate;
      if (data.length < rate * 0.5) return;
      const res = await bridge.backendRequest("transcribe_audio", { audio_base64: b64(wav16k(data, rate)), format: "wav", sample_rate: 16000, language: (localStorage.getItem("fidex_stt_lang") || "en"), final });
      if (!res.ok) {
        failed = true;
        show("err", "Transcription failed: " + ((res.error && res.error.message) || "unknown error"), 8000);
        if (listening) stop(true);
        return;
      }
      const text = String((res.data && res.data.text) || "").trim();
      if (text) lastText = text;
      // Backend requests are capped at 1 MB (~24 s of audio): once a segment is long enough,
      // commit its text into the input and start a fresh segment so long dictation never fails.
      if (data.length > rate * SEGMENT_SECONDS && lastText) {
        base = base + (base && !/\s$/.test(base) ? " " : "") + lastText;
        lastText = "";
        chunks.splice(0, n);
        onText(base);
      } else if (lastText) {
        onText(base + (base && !/\s$/.test(base) ? " " : "") + lastText);
      }
    } finally {
      inflight = false;
    }
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      show("err", "Microphone unavailable or permission denied.", 6000);
      return;
    }
    actx = new AudioContext();
    const src = actx.createMediaStreamSource(stream);
    proc = actx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(actx.destination);
    chunks = [];
    base = startBase = getText();
    lastText = "";
    failed = false;
    listening = true;
    setOn(true);
    show("rec", "Listening… speak now (click the mic to stop)");
    timer = setInterval(() => transcribe(false), 800);
  }

  async function stop(silent) {
    if (!listening) return;
    listening = false;
    clearInterval(timer);
    setOn(false);
    stream && stream.getTracks().forEach((t) => t.stop());
    try { proc.disconnect(); } catch (e) {}
    if (!silent) {
      micEl.classList.add("is-busy");
      show("", "Finishing…");
      while (inflight) await new Promise((r) => setTimeout(r, 100));
      await transcribe(true);
      micEl.classList.remove("is-busy");
      if (!failed) show("ok", (lastText || base !== startBase) ? "Done — edit if needed, then press Send." : "No speech detected.", 3000);
    }
    actx && actx.close().catch(() => {});
    actx = stream = proc = null;
  }

  micEl.addEventListener("click", () => (listening ? stop(false) : start()));
}
