// SpeedX: keeps replies quick and sharp. It refreshes only the AI's working window (the last exchange is kept, the loaded model is
// never reloaded, saved chats / memory / details are untouched). Automatic after every 4 replies, or when the SpeedX button is pressed.
// Nothing here is awaited by a chat request: sending and streaming never wait for a refresh.
const api = window.fidex || {};
const EVERY = 4;        // replies between automatic refreshes
const SHORT_FOR = 4;    // replies kept very short after the button is pressed
export const LABEL = "SpeedX: increases response speed";
let armed = false, sinceRefresh = 0, shortLeft = 0, ui = null, t1 = 0, t2 = 0;
const freshFrom = new Map(); // conversation id -> id of the first message the AI still sees

const valid = (m) => m && (m.role === "user" || m.role === "assistant") && !m.placeholder && !m.error && typeof m.text === "string" && m.text.trim();
export const isShort = () => shortLeft > 0;
export const windowStart = (convId) => freshFrom.get(convId) || null;

// New window = the last finished exchange (question + answer). Older turns are no longer sent to the AI.
function markFresh(conv) {
  if (!conv) return [];
  const v = (conv.messages || []).filter(valid);
  for (let j = v.length - 1; j >= 1; j--) {
    if (v[j].role === "assistant" && v[j - 1].role === "user") {
      freshFrom.set(conv.id, v[j - 1].id);
      return [v[j - 1], v[j]].map((m) => ({ role: m.role, content: m.text.slice(0, 280) }));
    }
  }
  return [];
}

// One painter for the bar. The fill is moved by this loop on every screen frame (the CSS transition is switched off so nothing can fight it):
// it eases toward the latest target, so 70 -> 100 flows instead of jumping, and the % number counts with it.
let shown = 0, target = 0, raf = 0, bu = null;
function frame() {
  const d = target - shown;
  const step = d * 0.22 + Math.sign(d) * 0.35; // gentle glide, no jumps
  if (Math.abs(d) < 0.05 || Math.abs(step) >= Math.abs(d)) shown = target; else shown += step; // never overshoots, so the number cannot shake
  bu.fill.style.height = shown + "%";
  const t = Math.round(shown) + "%"; if (bu.pct.textContent !== t) bu.pct.textContent = t;
  raf = shown === target ? 0 : requestAnimationFrame(frame);
}
export function paintBar(u, pct, text, instant) {
  bu = u; target = pct;
  u.fill.style.setProperty("transition", "none", "important");
  if (text) u.lab.textContent = text;
  u.bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  if (instant) { cancelAnimationFrame(raf); shown = pct; frame(); return; }
  if (!raf) raf = requestAnimationFrame(frame);
}
const paint = (p) => ui && paintBar(ui, p, LABEL);
export function hideBarLater(ms) {
  if (!ui) return;
  clearTimeout(t1); clearTimeout(t2);
  t1 = setTimeout(() => { ui.bar.classList.add("is-hiding"); t2 = setTimeout(() => { ui.bar.hidden = true; }, 700); }, ms);
}
// The bar comes back already almost full and only tops up while the refresh finishes (it never starts from zero).
let trick = 0;
function showBar(done) {
  if (!ui) return;
  clearTimeout(t1); clearTimeout(t2); clearInterval(trick);
  ui.bar.classList.remove("is-hiding", "is-failed", "is-ready");
  let p = 70;
  paintBar(ui, p, LABEL, true); // starts at 70 and climbs smoothly
  ui.bar.hidden = false;
  trick = setInterval(() => { p = Math.min(97, p + (98 - p) * 0.05 + 0.12); paint(p); }, 100); // keeps moving the whole time, slowing near the top
  done.then(() => {
    clearInterval(trick);
    trick = setInterval(() => { p = Math.min(100, p + (100 - p) * 0.3 + 0.6); paint(p); if (p >= 100) { clearInterval(trick); ui.bar.classList.add("is-ready"); hideBarLater(350); } }, 30); // flows into 100, never jumps
  });
}

let busy = false; // one refresh at a time: they never stack up and slow the model
function refresh(conv, manual) {
  if (busy) { if (manual) { shortLeft = SHORT_FOR; armed = true; } return; }
  busy = true; armed = true;
  sinceRefresh = 0;
  const carry = markFresh(conv);
  if (manual) { shortLeft = SHORT_FOR; if (typeof api.chatSpeedX === "function") api.chatSpeedX().catch(() => {}); } // also shortens a reply that is being written right now
  const done = typeof api.chatRefresh === "function" ? api.chatRefresh({ messages: carry }).catch(() => null) : Promise.resolve(null);
  const fin = done.then((x) => { busy = false; return x; }, () => { busy = false; return null; });
  showBar(fin);
}

export function afterReply(conv) { // called after every finished reply
  if (shortLeft > 0) shortLeft--;
  if (++sinceRefresh >= EVERY) refresh(conv, false); // automatic boosts only start after the first SpeedX click
}

// Called once, when the first bar has finished loading: only then does the SpeedX button appear.
export function initSpeedX({ bar, fill, lab, pct, btn, getConv }) {
  ui = { bar, fill, lab, pct }; // start-up only shows the brain loading; no refresh or trimming runs here
  if (!btn || btn.dataset.ready) return;
  btn.dataset.ready = "1"; btn.hidden = false;
  btn.addEventListener("click", () => refresh(getConv(), true));
}
