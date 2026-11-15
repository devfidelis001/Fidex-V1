// Real AI for Take Over and Guide Me. Memory (name + relevant permanent memory) is chosen by the backend from `mode`
// ("takeover" | "guide", see agent.context). Only final answers are returned; partial text is for display only.
import { streamRequest, stopStream } from "./stream.js";

const FRIENDLY = {
  AI_UNAVAILABLE: "My AI engine is reconnecting automatically. Try again in a few seconds.",
  AI_MODEL_MISSING: "The AI model is not installed yet. Restart FIDEX SI with FIDEX-SI-Model-qwen3.5-4b.zip next to the app; it is imported automatically.",
  AI_TIMEOUT: "The AI took too long to answer. Try again.",
  NOT_IN_ELECTRON: "The AI is only available in the desktop app.",
};

export function createAgentAi(mode) {
  let history = [];
  let busy = false;
  let control = null;
  return {
    // Stop: cancels the answer being written right now (the backend closes its connection to the model).
    stop: () => stopStream(control),
    reset: () => {
      history = [];
    },
    get busy() {
      return busy;
    },
    // Resolves {text} (final answer), {cancelled} (Stop pressed) or {error}. onToken(textSoFar) is called while the answer
    // is written. In Take Over the model really reasons (think) and onReasoning(textSoFar) shows that reasoning live.
    async ask(userText, onToken, onReasoning) {
      if (busy) return { error: "Still answering the previous message." };
      busy = true;
      history.push({ role: "user", content: String(userText).slice(0, 2000) });
      try {
        control = {};
        const think = false;
        const res = await streamRequest({ messages: history.slice(-12), mode, ...(think ? { think: true } : {}) }, onToken, undefined, control, think ? onReasoning : undefined);
        if (control.stopped || (res.ok && res.data && res.data.cancelled)) {
          history.pop();
          return { cancelled: true };
        }
        if (res.ok && res.data && res.data.text) {
          history.push({ role: "assistant", content: res.data.text });
          return { text: res.data.text };
        }
        history.pop();
        const code = res.error && res.error.code;
        return { error: FRIENDLY[code] || `Could not get an answer. ${(res.error && res.error.message) || ""}`.trim() };
      } finally {
        busy = false;
        control = null;
      }
    },
  };
}
