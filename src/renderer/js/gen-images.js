// Generated images are too big for localStorage, so they are kept in IndexedDB (on this device) and re-attached to their chat messages on start.
const DB = "fidex-gen-images", STORE = "images";
function open() {
  return new Promise((resolve, reject) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
}
function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode), out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(out && "result" in out ? out.result : undefined); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  }));
}
export const putImage = (id, dataUrl) => run("readwrite", (s) => s.put(dataUrl, id)).catch(() => {});
export const getImage = (id) => run("readonly", (s) => s.get(id)).catch(() => undefined);
export const deleteImages = (ids) => run("readwrite", (s) => { ids.forEach((i) => s.delete(i)); }).catch(() => {});
export const clearImages = () => run("readwrite", (s) => s.clear()).catch(() => {});
