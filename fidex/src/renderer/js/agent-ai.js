// Real AI for Take Over and Guide Me. Memory (name + relevant permanent memory) is chosen by the backend from `mode`
// ("takeover" | "guide", see agent.context). Only final answers are returned; partial text is for display only.
import { streamRequest } from "./stream.js";

const FRIENDLY = {
  AI_UNAVAILABLE: "I cannot reach my AI engine. Start Ollama, then try again.",
  AI_MODEL_MISSING: "My AI model is not installed. Run once: ollama pull qwen3:4b",
  AI_TIMEOUT: "The AI took too long to answer. Try again.",
  NOT_IN_ELECTRON: "The AI is only available in the desktop app.",
};

export function createAgentAi(mode) {
  let history = [];
  let busy = false;
  return {
    reset: () => {
      history = [];
    },
    get busy() {
      return busy;
    },
    // Resolves {text} (final answer) or {error}. onToken(textSoFar) is called while the answer is written.
    async ask(userText, onToken) {
      if (busy) return { error: "Still answering the previous message." };
      busy = true;
      history.push({ role: "user", content: String(userText).slice(0, 2000) });
      try {
        const res = await streamRequest({ messages: history.slice(-12), mode }, onToken);
        if (res.ok && res.data && res.data.text) {
          history.push({ role: "assistant", content: res.data.text });
          return { text: res.data.text };
        }
        history.pop();
        const code = res.error && res.error.code;
        return { error: FRIENDLY[code] || `Could not get an answer. ${(res.error && res.error.message) || ""}`.trim() };
      } finally {
        busy = false;
      }
    },
  };
}
