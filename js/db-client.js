// Local storage client (Step 5). A thin, named wrapper over the secure bridge, so later steps can
// write `db.conversations.create({title})` instead of repeating request-type strings.
//
// It adds NOTHING to the screen. The interface never touches
// the database: every call below is just window.fidex.backendRequest(type, payload), which goes
// preload -> main process -> Python, where SQLite lives. Each call resolves to
// {ok:true,type,data} or {ok:false,type,error:{code,message}} and never throws.

import { bridge } from "./bridge.js";

const send = (type, payload = {}) => bridge.backendRequest(type, payload);

export const db = {
  status: () => send("db.status"),
  conversations: {
    create: (fields) => send("conversation.create", fields), // {title?, id?}
    get: (id) => send("conversation.get", { id }),
    list: (options) => send("conversation.list", options), // {limit?, offset?}
    update: (id, title) => send("conversation.update", { id, title }),
    delete: (id) => send("conversation.delete", { id }),
  },
  messages: {
    create: (fields) => send("message.create", fields), // {conversation_id, role, content, id?}
    get: (id) => send("message.get", { id }),
    list: (conversationId, options) => send("message.list", { conversation_id: conversationId, ...options }),
    update: (id, content) => send("message.update", { id, content }),
    delete: (id) => send("message.delete", { id }),
  },
  tasks: {
    create: (fields) => send("task.create", fields), // {title, description?, status?, conversation_id?, id?}
    get: (id) => send("task.get", { id }),
    list: (options) => send("task.list", options), // {status?, conversation_id?, limit?, offset?}
    update: (id, fields) => send("task.update", { id, ...fields }), // {title?, description?, status?}
    delete: (id) => send("task.delete", { id }),
  },
  // Step 6: automatic save progress. The panel saves through work.save as it changes; after a
  // restart work.restore reports unfinished tasks. Nothing is ever executed by these calls.
  work: {
    save: (snapshot) => send("work.save", snapshot), // {id, title?, status?, progress?, steps?, requests?, context?...}
    restore: () => send("work.restore"),
    resume: (id) => send("work.resume", { id }),
    discard: (id) => send("work.discard", { id }),
    addContext: (fields) => send("work.context.add", fields), // {kind, content, task_id?}
  },
};
