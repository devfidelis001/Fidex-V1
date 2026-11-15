// Streaming link to the AI: sends chat.stream and reports the answer as it is written.
// Kept separate from responder.js so the Take Over window and Guide Me can use it too.
import { bridge } from "./bridge.js";

// Sends chat.stream and calls onToken(textSoFar) as pieces arrive. Resolves like a normal backend reply:
// the final cleaned answer (res.data.text) is what gets shown and saved, never the partial text.
let streamCounter = 0;
export async function streamRequest(payload, onToken, onStage) {
  const id = `s${Date.now().toString(36)}${++streamCounter}`;
  let so_far = "";
  const off = bridge.onBackendEvent((evt) => {
    if (!evt || !evt.data || evt.data.stream_id !== id) return;
    if (evt.event === "chat.token" && typeof onToken === "function") {
      so_far += evt.data.text || "";
      onToken(so_far);
    } else if (evt.event === "chat.stage" && typeof onStage === "function") {
      onStage(String(evt.data.text || ""));
    }
  });
  try {
    return await bridge.backendRequest("chat.stream", { ...payload, stream_id: id });
  } finally {
    off();
  }
}
