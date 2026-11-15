// Streaming link to the AI: sends chat.stream and reports the answer as it is written.
// Kept separate from responder.js so the Take Over window and Guide Me can use it too.
import { bridge } from "./bridge.js";

// Sends chat.stream and calls onToken(textSoFar) as pieces arrive. Resolves like a normal backend reply:
// the final cleaned answer (res.data.text) is what gets shown and saved, never the partial text.
let streamCounter = 0;
export async function streamRequest(payload, onToken, onStage, control, onReasoning) {
  const id = `s${Date.now().toString(36)}${++streamCounter}`;
  if (control) control.id = id; // lets stopStream() cancel exactly this answer
  let so_far = "";
  let reasoning = "";
  const off = bridge.onBackendEvent((evt) => {
    if (!evt || !evt.data || evt.data.stream_id !== id) return;
    if (evt.event === "chat.token" && typeof onToken === "function") {
      so_far += evt.data.text || "";
      onToken(so_far);
    } else if (evt.event === "chat.reasoning" && typeof onReasoning === "function") {
      reasoning += evt.data.text || "";
      onReasoning(reasoning);
    } else if (evt.event === "chat.stage" && typeof onStage === "function") {
      onStage(String(evt.data.text || ""));
    }
  });
  try {
    if (control && control.stopped) bridge.backendRequest("chat.cancel", { stream_id: id }); // Stop was pressed before the request left
    return await bridge.backendRequest("chat.stream", { ...payload, stream_id: id });
  } finally {
    off();
  }
}

// Stop Generation: cancels the answer being written for this control object. The backend closes its connection to
// the model right away, so generation really stops and the backend is free for the next message.
export function stopStream(control) {
  if (!control) return Promise.resolve(null);
  control.stopped = true;
  return control.id ? bridge.backendRequest("chat.cancel", { stream_id: control.id }) : Promise.resolve(null);
}
