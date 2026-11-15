"use strict";

// The Electron IPC channels between the interface and the Python backend.
// The interface can only reach these two channels (through preload.js); it never sees Node,
// processes or file paths. Every handler answers with a plain {ok,...} object and never throws.

const CHANNELS = {
  request: "backend:request",
  status: "backend:status",
  statusChanged: "backend:status-changed",
  event: "backend:event", // streamed AI tokens (chat.token)
};

function registerBackendIpc({ ipcMain, bridge, isTrustedSender, sendStatus, sendEvent, logger }) {
  const refuse = (type, message) => ({
    ok: false,
    type: typeof type === "string" ? type : null,
    error: { code: "IPC_REFUSED", message },
  });

  ipcMain.handle(CHANNELS.request, async (event, type, payload) => {
    try {
      if (!isTrustedSender(event)) {
        logger.warn("refused a backend request from an unknown sender");
        return refuse(type, "Request refused.");
      }
      return await bridge.request(type, payload);
    } catch (err) {
      // bridge.request never throws; this is a seatbelt, not an expected path
      logger.error(`unexpected error handling backend request: ${err && err.message}`);
      return { ok: false, type: typeof type === "string" ? type : null, error: { code: "BACKEND_ERROR", message: "Unexpected error in the desktop application." } };
    }
  });

  ipcMain.handle(CHANNELS.status, (event) => {
    if (!isTrustedSender(event)) return null;
    return bridge.getStatus();
  });

  bridge.on("backend-event", (evt) => {
    if (!evt || (evt.event !== "chat.token" && evt.event !== "chat.stage") || typeof sendEvent !== "function") return;
    try {
      sendEvent(CHANNELS.event, evt);
    } catch (err) {
      logger.warn(`could not send a streamed token to the window: ${err && err.message}`);
    }
  });

  bridge.on("status", (status) => {
    try {
      sendStatus(CHANNELS.statusChanged, status);
    } catch (err) {
      logger.warn(`could not send backend status to the window: ${err && err.message}`);
    }
  });
}

module.exports = { registerBackendIpc, CHANNELS };
