// Random waiting animations for the image phase (canvas, white, glowing dots): 8 animations, equal chance.
const W = 160, H = 40;

const dot = (ctx, x, y, r, a) => { ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); };
const glow = (ctx, b) => { ctx.fillStyle = "#fff"; ctx.strokeStyle = "#fff"; ctx.shadowColor = "#fff"; ctx.shadowBlur = b; };

const ANIMS = [
  () => (ctx, t) => { // 1. wave of dots (the original favourite, unchanged)
    glow(ctx, 8); for (let i = 0; i < 7; i++) dot(ctx, W / 2 - 42 + i * 14, H / 2 + Math.sin(t / 260 + i * 0.7) * 9, 3, 0.4 + 0.55 * ((Math.sin(t / 260 + i * 0.7) + 1) / 2));
  },
  () => (ctx, t) => { // 2. ripple: the wave spreads out from the middle dot
    glow(ctx, 8); for (let i = 0; i < 9; i++) { const s = Math.sin(t / 340 - Math.abs(i - 4) * 0.85); dot(ctx, W / 2 - 48 + i * 12, H / 2 + s * 9, 2.8, 0.4 + 0.55 * ((s + 1) / 2)); }
  },
  () => (ctx, t) => { // 3. twin wave: two rows that mirror each other, breathing together
    glow(ctx, 8); for (let i = 0; i < 7; i++) { const s = Math.sin(t / 300 + i * 0.6), g = 5 + 5 * ((s + 1) / 2); dot(ctx, W / 2 - 42 + i * 14, H / 2 - g, 2.8, 0.45 + 0.5 * ((s + 1) / 2)); dot(ctx, W / 2 - 42 + i * 14, H / 2 + g, 2.8, 0.45 + 0.5 * ((s + 1) / 2)); }
  },
  () => (ctx, t) => { // 4. triplets: three dots per column that open and close one column after another
    glow(ctx, 8); for (let i = 0; i < 5; i++) { const s = (Math.sin(t / 380 - i * 0.8) + 1) / 2, x = W / 2 - 40 + i * 20; dot(ctx, x, H / 2, 3, 0.9); dot(ctx, x, H / 2 - 4 - s * 8, 2.4, 0.4 + 0.5 * s); dot(ctx, x, H / 2 + 4 + s * 8, 2.4, 0.4 + 0.5 * s); }
  },
  () => (ctx, t) => { // 5. drifting rhythm: every dot has its own slow speed, so the pattern keeps changing
    glow(ctx, 8); for (let i = 0; i < 8; i++) { const s = Math.sin(t / (520 - i * 22) + i), r = 2.4 + 0.9 * ((s + 1) / 2); dot(ctx, W / 2 - 49 + i * 14, H / 2 + s * 10, r, 0.45 + 0.5 * ((s + 1) / 2)); }
  },
  () => (ctx, t) => { // 6. bubbles: dots float gently upward, fading in and out
    glow(ctx, 8); for (let i = 0; i < 9; i++) { const p = (t / 2200 + i * 0.37) % 1, e = p * p * (3 - 2 * p); dot(ctx, W / 2 - 48 + i * 12, H - 4 - e * (H - 8), 2.2 + 1.2 * Math.sin(p * Math.PI), Math.sin(p * Math.PI) * 0.95); }
  },
  () => (ctx, t) => { // 7. ribbon: many small dots on a smooth sine line that glides along
    glow(ctx, 6); for (let i = 0; i < 22; i++) { const x = 14 + i * 6.4, s = Math.sin(i * 0.5 - t / 330); dot(ctx, x, H / 2 + s * 8 * Math.sin((i / 21) * Math.PI), 2.1, 0.5 + 0.45 * ((s + 1) / 2)); }
  },
  () => (ctx, t) => { // 8. seesaw: neighbours rise and fall in opposite directions, slowly swapping
    glow(ctx, 8); for (let i = 0; i < 7; i++) { const s = Math.sin(t / 360 + i * Math.PI) * (0.65 + 0.35 * Math.sin(t / 1100 + i)); dot(ctx, W / 2 - 42 + i * 14, H / 2 + s * 9, 3, 0.45 + 0.5 * ((s + 1) / 2)); }
  },
];

export function startAnim(container) {
  const cv = document.createElement("canvas");
  cv.className = "ai-anim";
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + "px"; cv.style.height = H + "px";
  container.append(cv);
  const ctx = cv.getContext("2d");
  const draw = ANIMS[Math.floor(Math.random() * ANIMS.length)](); // 8 animations, equal chance
  let raf = 0, dead = false;
  const loop = (t) => {
    if (dead || !cv.isConnected) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    draw(ctx, t);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => { dead = true; cancelAnimationFrame(raf); cv.remove(); };
}
