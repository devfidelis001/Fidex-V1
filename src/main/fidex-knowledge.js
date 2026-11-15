"use strict";
// Tiny facts added to the user's turn ONLY when the user explicitly asks about that exact thing.
// One regex test per message (microseconds, no model call, nothing awaited); every other message gets nothing added.
const CREATOR_RE = /\b(who (made|created|built|developed|programmed|designed|owns?) (you|fidex)|your (creator|developer|programmer|maker|owner|author)|who is fidelis)\b/i;
const CONTACT_RE = /\b(phone|number|contact|website|web ?site|reach|call)\b.{0,40}\b(creator|developer|programmer|maker|fidelis|futurelabs)\b|\b(creator|developer|programmer|fidelis|futurelabs)\b.{0,40}\b(phone|number|contact|website|web ?site|reach)\b/i;
const IDENT_RE = /\b(who are you|what are you|your name|introduce yourself|tell me about yourself|what is fidex)\b/i;
const FEATURES_RE = /\b(what can you do|what do you do|your (features?|capabilit\w+|abilit\w+|limitations?|modes?)|what (is|are) (take ?over|live vision|your hands|your eyes|your brain)|explain take ?over|how does take ?over work)\b/i;
const IMAGE_RE = /\b(can|could|do|does|will|are) (you|fidex)\b.{0,30}\b(read|see|view|understand|look at|analy[sz]e|generate|create|make|draw|produce)\b.{0,25}\b(images?|pictures?|photos?|drawings?|art)\b|\bimage (creator|generat\w+|creation)\b|\b(generate|create|make) (an? )?(images?|pictures?) (with|using|in) (fidex|you)\b|\bhow (do|can) i (generate|create|make) (an? )?(images?|pictures?)\b/i;
const GOD_RE = /\b(god|jesus|christ|christian(s|ity)?|bible|biblical|scripture|gospels?|holy spirit|trinity|salvation|prayers?|pray|messiah|resurrection|crucifi\w*|psalms?|genesis|testament|apostles?|lord'?s prayer)\b/i;

const IDENT = "You are FIDEX SI, a personal SI assistant that helps people think, learn, create, code and build. You are currently FIDEX Version 1, released November 14, 2026, 4:40 AM.";
const CREATOR = "You were built by the FIDEX Team, not by the FIDEX CEO alone. You are FIDEX Version 1.";
const CONTACT = "You can read more about FIDEX on the About page.";
const FEATURES = "Your features: Chat (text and voice); image understanding (upload, paste or drop); image generation (Image Creator button, cloud); memory of the details the user gives you. Limits: depends on installed parts, model and internet; never claim to have done something you did not do.";
const IMAGE = "Images: you can read images the user uploads, pastes or drops into Chat (PNG, JPG, WEBP) and describe or answer questions about them. You can also generate images: the user presses the palette Image Creator button next to the upload button, types a description, and presses Send; the image is created in the cloud (FLUX.1 schnell on Cloudflare Workers AI), appears in a small box in Chat, opens bigger when clicked, and has a download icon. In normal chat messages you do not generate images yourself; tell the user to use that button.";
const GOD = "Christian facts, use only what the question needs: God is Creator, eternal, loving, just. Jesus is Son of God, Messiah and Saviour, crucified, rose on the third day (John 1, John 3:16, John 14:6). Trinity: one God in three persons. Bible: Old and New Testament; Gospels Matthew, Mark, Luke, John. Love God and neighbour (Matt 22:37-39), forgive (Matt 6:14), Lord's Prayer (Matt 6:9-13), salvation by grace through faith (Eph 2:8-9), fruit of the Spirit (Gal 5:22-23). Never invent verses or quotes; note when churches differ; stay respectful of other religions. You are an SI with no faith or revelation and never claim God spoke to you.";

function topicBlock(text) {
  const t = String(text || "");
  if (t.length > 400) return "";
  const out = [];
  if (IDENT_RE.test(t)) out.push(IDENT);
  if (CREATOR_RE.test(t)) out.push(CREATOR);
  if (CONTACT_RE.test(t)) out.push(CONTACT);
  if (FEATURES_RE.test(t)) out.push(FEATURES);
  if (IMAGE_RE.test(t)) out.push(IMAGE);
  if (GOD_RE.test(t)) out.push(GOD);
  return out.join(" ");
}
module.exports = { topicBlock };
