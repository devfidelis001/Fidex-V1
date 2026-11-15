// Automatic save for the Take Over panel (Step 6). Every state change is sent to the backend
// (window.fidex.backendRequest -> Python -> SQLite) as soon as it happens.
//
// * Saves go out one at a time, in order. While one is in flight only the LATEST newer state is
//   kept (older ones are superseded), so a burst of changes never floods the backend.
// * An identical state is not sent twice.
// * A failed save is retried with a short pause. It is only counted as saved when the backend
//   confirms it, so `lastSavedAt` never claims more than the database really holds.

import { db } from "./db-client.js";
import { toSavePayload } from "./progress-map.js";

export function createProgressSaver({ stepIds, send = (payload) => db.work.save(payload), retryMs = 1500, maxRetries = 5, log = console } = {}) {
  let latest = null; // newest payload not yet confirmed
  let lastSentJson = "";
  let busy = false;
  let timer = null;
  let failures = 0;
  let idle = Promise.resolve();
  let release = () => {};
  const out = { lastSavedAt: null, lastError: null };

  async function pump() {
    if (busy || !latest) return;
    busy = true;
    idle = new Promise((r) => (release = r));
    while (latest) {
      const payload = latest;
      const json = JSON.stringify(payload);
      if (json === lastSentJson) {
        latest = null;
        break;
      }
      let res;
      try {
        res = await send(payload);
      } catch (err) {
        res = { ok: false, error: { code: "SAVE_FAILED", message: String((err && err.message) || err) } };
      }
      if (res && res.ok) {
        failures = 0;
        out.lastError = null;
        out.lastSavedAt = res.data && res.data.saved_at ? res.data.saved_at : out.lastSavedAt;
        lastSentJson = json;
        if (latest === payload) latest = null; // a newer state may have arrived meanwhile: loop again
      } else {
        out.lastError = (res && res.error) || { code: "SAVE_FAILED", message: "unknown" };
        failures += 1;
        if (out.lastError.code === "NOT_IN_ELECTRON" || failures > maxRetries || out.lastError.code === "INVALID_PAYLOAD") {
          if (out.lastError.code !== "NOT_IN_ELECTRON") log.warn(`[save] progress could not be saved: ${out.lastError.code}`);
          if (latest === payload) latest = null; // give up on this one; the next change tries again
          failures = 0;
        } else {
          timer = setTimeout(() => {
            timer = null;
            pump();
          }, retryMs);
          break;
        }
      }
    }
    busy = false;
    release();
  }

  return {
    /** Call on every panel change. */
    queue(state) {
      latest = toSavePayload(state, stepIds);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pump();
    },
    /** Resolves when everything queued so far has been confirmed (or given up on). For tests and shutdown. */
    flush: async () => {
      await Promise.resolve();
      await idle;
    },
    get status() {
      return { ...out };
    },
  };
}
