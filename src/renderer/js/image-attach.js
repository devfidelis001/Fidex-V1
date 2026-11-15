// Image upload for chat: button -> preview -> remove. Decodes and shrinks the picture ONCE in the window (PNG, JPG, JPEG, WEBP),
// so an unreadable file is caught here and the main process only ever receives a small JPEG.
const MAX_SIDE = 640;      // long side sent to the model: text stays readable, fewer image tokens = faster first word
const THUMB_SIDE = 480;    // small copy kept in the conversation
const MAX_FILE = 25 * 1024 * 1024;
const OK_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const OK_EXT = /\.(png|jpe?g|webp)$/i;

function scaled(bitmap, side, quality) {
  const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); // transparent PNG/WEBP areas become white, not black
  g.drawImage(bitmap, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality);
}

// Cheap fingerprint of the shrunk image: the same picture is analysed only once.
function fingerprint(s) {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i += 7) { const c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 31 + c) | 0; }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

export async function prepareImage(file) {
  if (!file) throw new Error("No file selected.");
  if (!OK_TYPES.has(file.type) && !OK_EXT.test(file.name || "")) throw new Error("Only PNG, JPG, JPEG and WEBP images are supported.");
  if (file.size > MAX_FILE) throw new Error("That image is too large (25 MB maximum).");
  if (file.size === 0) throw new Error("That image file is empty.");
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch (_) { throw new Error("I could not read that image. It may be damaged or not a real image."); }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error("empty");
    const full = scaled(bitmap, MAX_SIDE, 0.8);
    const thumb = scaled(bitmap, THUMB_SIDE, 0.75);
    return { name: file.name || "image", preview: thumb, data: full.slice(full.indexOf(",") + 1), hash: fingerprint(full), width: bitmap.width, height: bitmap.height };
  } catch (_) {
    throw new Error("I could not read that image. It may be damaged or not a real image.");
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
}

// Starts Vision the moment the image is attached (generic findings, cached by fingerprint in the main process).
function prefetch(c) { const a = window.fidex; if (c && a && typeof a.chatStart === "function") a.chatStart({ prefetch: true, id: c.hash, image: { data: c.data } }).catch(() => {}); }
function cancelPrefetch(c) { const a = window.fidex; if (c && a && typeof a.chatStart === "function") a.chatStart({ prefetch: true, cancel: true, id: c.hash }).catch(() => {}); }

export function createImageAttach({ buttonEl, fileEl, previewEl, onChange, onError, inputEl, dropEl }) {
  let current = null, busy = false;
  const img = previewEl.querySelector("img"), nameEl = previewEl.querySelector(".attach-name"), rm = previewEl.querySelector("button");

  function show() {
    previewEl.hidden = !current;
    if (current) { img.src = current.preview; nameEl.textContent = current.name; }
    buttonEl.classList.toggle("has-image", !!current);
    if (onChange) onChange(current);
  }
  function clear(cancel) { if (cancel) cancelPrefetch(current); current = null; fileEl.value = ""; show(); }

  async function load(file) {
    if (busy) return;
    busy = true; buttonEl.classList.add("is-busy");
    try { const next = await prepareImage(file); if (current && current.hash !== next.hash) cancelPrefetch(current); current = next; show(); prefetch(current); }
    catch (err) { current = null; show(); if (onError) onError(err.message || String(err)); }
    finally { busy = false; buttonEl.classList.remove("is-busy"); fileEl.value = ""; }
  }

  buttonEl.addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", () => { if (fileEl.files && fileEl.files[0]) load(fileEl.files[0]); });
  rm.addEventListener("click", () => clear(true));

  // Copy an image and paste it (Ctrl+V) into the chat box, or drag an image onto the chat: same path as the upload button.
  const imageOf = (list) => Array.from(list || []).find((f) => f && (OK_TYPES.has(f.type) || (f.type === "" && OK_EXT.test(f.name || ""))));
  if (inputEl) inputEl.addEventListener("paste", (e) => {
    const f = imageOf(e.clipboardData && e.clipboardData.files);
    if (!f) return; // plain text paste stays untouched
    e.preventDefault();
    load(f);
  });
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const zone = dropEl || document.body;
  zone.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  zone.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const f = imageOf(e.dataTransfer.files);
    if (f) load(f); else if (onError) onError("Only PNG, JPG, JPEG and WEBP images are supported.");
  });
  for (const t of ["dragover", "drop"]) window.addEventListener(t, (e) => { if (hasFiles(e)) e.preventDefault(); }); // a dropped file must never navigate the app away
  return { get: () => current, take: () => { const c = current; clear(); return c; }, clear, load };
}
