// FIDEX AI first-run intro: "UNBOXING YOUR CEO" (7 seconds).
// A tiny self-contained software 3D renderer (z-buffer, per-pixel lighting) draws an all-white boy,
// box and robot on a black background. No libraries, no assets, no network.

import { HAND_FONT } from "./intro-font.js";

// ---------- Math (3x4 row-major matrices) ----------
const I3 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; };
const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; };
const RZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; };
function mul(A, B) {
  const r = new Array(12);
  for (let i = 0; i < 3; i++) {
    const a0 = A[i * 4], a1 = A[i * 4 + 1], a2 = A[i * 4 + 2];
    for (let j = 0; j < 3; j++) r[i * 4 + j] = a0 * B[j] + a1 * B[4 + j] + a2 * B[8 + j];
    r[i * 4 + 3] = a0 * B[3] + a1 * B[7] + a2 * B[11] + A[i * 4 + 3];
  }
  return r;
}
const chain = (...m) => m.reduce((a, b) => mul(a, b));
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const sstep = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
const seg = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const backOut = (x) => { x = clamp(x); const c1 = 1.2, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
function keys(t, k) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t <= k[i][0]) return lerp(k[i - 1][1], k[i][1], sstep((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0])));
  return k[k.length - 1][1];
}

// ---------- Meshes ----------
function lathe(prof, seg_ = 20) {
  const n = prof.length;
  const pos = new Float32Array(n * seg_ * 3), nor = new Float32Array(n * seg_ * 3), idx = [];
  for (let i = 0; i < n; i++) {
    const a = prof[Math.max(i - 1, 0)], b = prof[Math.min(i + 1, n - 1)];
    let nr = -(b[1] - a[1]), ny = b[0] - a[0];
    const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
    for (let j = 0; j < seg_; j++) {
      const ang = (j / seg_) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), o = (i * seg_ + j) * 3;
      pos[o] = prof[i][0] * c; pos[o + 1] = prof[i][1]; pos[o + 2] = prof[i][0] * s;
      nor[o] = nr * c; nor[o + 1] = ny; nor[o + 2] = nr * s;
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg_; j++) {
    const a = i * seg_ + j, b = i * seg_ + ((j + 1) % seg_), c = (i + 1) * seg_ + j, d = (i + 1) * seg_ + ((j + 1) % seg_);
    idx.push(a, c, b, b, c, d);
  }
  return { pos, nor, idx: new Uint16Array(idx) };
}
function limb(r, L, seg_ = 16, H = 6) { // two round ends, pivot at the top sphere centre, hangs down
  const p = [];
  for (let k = 0; k <= H; k++) { const a = (k / H) * Math.PI / 2; p.push([r * Math.sin(a), r * Math.cos(a)]); }
  for (let k = 0; k <= H; k++) { const a = (k / H) * Math.PI / 2; p.push([r * Math.cos(a), -L - r * Math.sin(a)]); }
  return lathe(p, seg_);
}
function ellipsoid(rx, ry, seg_ = 24, H = 14) {
  const p = [];
  for (let k = 0; k <= H; k++) { const a = (k / H) * Math.PI; p.push([rx * Math.sin(a), ry * Math.cos(a)]); }
  return lathe(p, seg_);
}
function cyl(r, h, seg_ = 20) {
  const e = Math.min(0.006, h / 3);
  return lathe([[0, h / 2], [r - e, h / 2], [r, h / 2 - e], [r, -h / 2 + e], [r - e, -h / 2], [0, -h / 2]], seg_);
}
function torus(R, r, seg_ = 40, H = 14) {
  const p = [];
  for (let k = 0; k <= H; k++) { const a = (k / H) * Math.PI * 2; p.push([R + r * Math.sin(a), r * Math.cos(a)]); }
  return lathe(p, seg_);
}
function box(w, h, d, ox = 0, oy = 0, oz = 0) { // flat-shaded
  const X = w / 2, Y = h / 2, Z = d / 2, pos = [], nor = [], idx = [];
  const faces = [
    [[1, 0, 0], [[X, -Y, -Z], [X, Y, -Z], [X, Y, Z], [X, -Y, Z]]],
    [[-1, 0, 0], [[-X, -Y, Z], [-X, Y, Z], [-X, Y, -Z], [-X, -Y, -Z]]],
    [[0, 1, 0], [[-X, Y, -Z], [-X, Y, Z], [X, Y, Z], [X, Y, -Z]]],
    [[0, -1, 0], [[-X, -Y, Z], [-X, -Y, -Z], [X, -Y, -Z], [X, -Y, Z]]],
    [[0, 0, 1], [[-X, -Y, Z], [X, -Y, Z], [X, Y, Z], [-X, Y, Z]]],
    [[0, 0, -1], [[X, -Y, -Z], [-X, -Y, -Z], [-X, Y, -Z], [X, Y, -Z]]],
  ];
  for (const [n, vs] of faces) {
    const b = pos.length / 3;
    for (const v of vs) { pos.push(v[0] + ox, v[1] + oy, v[2] + oz); nor.push(n[0], n[1], n[2]); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
}

// ---------- Scene constants and meshes ----------
const BX = 0;            // box centre x
const HW = 0.5;         // box half width
const BH = 0.8;         // box height
const TH = 0.016;        // panel thickness
// egg profile (top -> bottom), slightly narrower at the top, like the real f-bot
function egg(rx, ry, a0, a1, H = 24) {
  const p = [];
  for (let k = 0; k <= H; k++) { const a = lerp(a0, a1, k / H); p.push([rx * Math.sin(a) * (1 - 0.09 * Math.cos(a)), ry * Math.cos(a)]); }
  return p;
}
function rrect(w, h, r, n = 5) { // flat rounded rectangle facing +z (face parts)
  const pos = [], nor = [], idx = [];
  const cs = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 1], [-w / 2 + r, -h / 2 + r, 2], [w / 2 - r, -h / 2 + r, 3]];
  const ring = [];
  for (const [cx, cy, q] of cs) for (let k = 0; k <= n; k++) { const a = (q * Math.PI) / 2 + (k / n) * Math.PI / 2; ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  pos.push(0, 0, 0); nor.push(0, 0, 1);
  for (const v of ring) { pos.push(v[0], v[1], 0); nor.push(0, 0, 1); }
  for (let i = 0; i < ring.length; i++) idx.push(0, 1 + i, 1 + ((i + 1) % ring.length));
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint16Array(idx) };
}
const mat = (mesh, o) => Object.assign(mesh, o);
const EY = 0.2, EX = 0.14; // body half height / half width (local units)
const M = {
  floor: box(HW * 2, TH, HW * 2, 0, TH / 2, 0),
  wallX: box(TH, BH, HW * 2),
  wallZ: box(HW * 2, BH, TH),
  flapZ: box(HW * 2, TH, HW),
  flapX: box(HW, TH, HW * 2),
  body: mat(lathe(egg(EX, EY, 0, Math.PI, 36), 40), { glass: 1 }),
  hat: mat(lathe(egg(EX * 1.06, EY * 1.06, 0, 0.285 * Math.PI, 14), 40), { tone: 0.5 }),
  hatRim: mat(torus(0.105, 0.014, 40, 10), { tone: 0.66 }),
  arm: mat(limb(0.02, 0.085, 14, 6), { glass: 1, boost: 1 }),
  foot: mat(ellipsoid(0.032, 0.08, 20, 12), { glass: 1, boost: 1 }),
  eye: mat(rrect(0.056, 0.066, 0.02), { late: 1, tone: 0.03 }),
  mouth: mat(rrect(0.046, 0.011, 0.005, 3), { late: 1, tone: 0.03 }),
};

// ---------- Scene ----------
const SC = (k) => [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0];
const RS = 1.5;                 // robot scale
const PX = -0.5;                // box start centre x (pivot = PX + HW)
const X1 = 1.55;                // where the robot ends up standing
const HITS = [1.1, 1.6, 2.05];

function pulse(t) {
  let v = 0;
  for (let i = 0; i < HITS.length; i++) { const d = t - HITS[i]; if (d > 0) v += Math.exp(-d * 9) * Math.sin(d * 42) * (0.7 + i * 0.25); }
  return v;
}

function boxAngle(t) {
  let phi = -0.13 * sstep(seg(t, 1.9, 2.35));
  const u = seg(t, 2.35, 3.0);
  phi = lerp(phi, -Math.PI / 2, u * u);
  if (t > 3.0) { const d = t - 3.0; phi += 0.07 * Math.exp(-d * 7) * Math.abs(Math.sin(d * 13)); }
  return phi;
}

const ph0 = (t) => t * 8;
function buildScene(t) {
  const parts = [];
  const add = (mesh, m) => parts.push([mesh, m]);
  const appear = sstep(seg(t, 0.05, 1.0));
  const pl = pulse(t), phi = boxAngle(t);
  const boxM = chain(
    T(PX + HW + pl * 0.012, (1 - appear) * 0.9 + Math.abs(pl) * 0.025, 0),
    RZ(phi + pl * 0.035), RX(pl * 0.02), T(-HW, 0, 0), RY((1 - appear) * 1.3 - 0.3 * 0 + 0.0)
  );
  add(M.floor, boxM);
  add(M.wallX, chain(boxM, T(HW - TH / 2, BH / 2, 0)));
  add(M.wallX, chain(boxM, T(-HW + TH / 2, BH / 2, 0)));
  add(M.wallZ, chain(boxM, T(0, BH / 2, HW - TH / 2)));
  add(M.wallZ, chain(boxM, T(0, BH / 2, -HW + TH / 2)));
  const fl = (a, b) => backOut(seg(t, a, b));
  const pop = Math.max(0, pl) * 0.18;
  const oF = fl(2.85, 3.6) * 4.3 + pop, oB = fl(2.95, 3.7) * 4.3 + pop, oL = fl(3.05, 3.8) * 2.45 + pop, oR = fl(3.0, 3.7) * 0.9 + pop;
  add(M.flapZ, chain(boxM, T(0, BH + TH * 0.5, HW), RX(oF), T(0, 0, -HW / 2)));
  add(M.flapZ, chain(boxM, T(0, BH + TH * 0.5, -HW), RX(-oB), T(0, 0, HW / 2)));
  add(M.flapX, chain(boxM, T(HW, BH + TH * 1.6, 0), RZ(-oR), T(-HW / 2, 0, 0)));
  add(M.flapX, chain(boxM, T(-HW, BH + TH * 1.6, 0), RZ(oL), T(HW / 2, 0, 0)));

  // --- Robot: rigid inside the box, then crawls out, stands up, waves ---
    const w = sstep(seg(t, 4.5, 5.3));      // crawl pose -> stand pose
  const crawl = sstep(seg(t, 3.3, 4.6));
  const R = { x: 0, y: 0 };
  let rm;
  if (t < 3.3) {
    rm = chain(boxM, T(0, 0.1, 0), SC(RS));
    const wm = chain(boxM, T(0, 0.1, 0)); R.x = wm[3]; R.y = wm[7] + 0.2;
  } else {
    const bx0 = PX + HW + 0.1, by0 = 0.5;
    const lipDrop = sstep(seg(t, 3.9, 4.5));
    const bx = lerp(bx0, X1, crawl) + Math.sin(t * 6) * 0.01 * (1 - w);
    const by = lerp(lerp(by0, 0.24, lipDrop), 0.0 + Math.sin(t * 2.4) * 0.006 * w, w);
    const a = (Math.PI / 2) * (1 - w);
    rm = chain(T(bx, by, 0), RY(0.2 * w), RZ(-a), RX(Math.sin(t * 6) * 0.05 * (1 - w)), SC(lerp(RS, 2.25, w)));
    R.x = bx; R.y = by + 0.23 * lerp(RS, 2.25, w);
  }
  const YC = 0.23;                           // body centre height
  const bob = Math.sin(t * 2.4) * 0.006 * w;
  add(M.hat, chain(rm, T(0, YC, 0)));
  add(M.hatRim, chain(rm, T(0, YC + 0.1325, 0)));
  add(M.body, chain(rm, T(0, YC, 0)));
  // face, sitting on the egg surface just under the hat
  const eggR = (y) => { const c = y / EY, sn = Math.sqrt(1 - c * c); return EX * sn * (1 - 0.09 * c); };
  const ey = 0.092, er = eggR(ey), ex = 0.067, ang = Math.asin(ex / er);
  for (const s of [-1, 1]) add(M.eye, chain(rm, T(0, YC + ey, 0), RY(s * ang), T(0, 0, er + 0.004)));
  add(M.mouth, chain(rm, T(0, YC + 0.08, er + 0.004)));
  // stubby glass arms and leaf feet
  const sway = Math.sin(t * 2.4 + 1) * 0.05 * w + Math.sin(ph0(t)) * 0.45 * (1 - w);
  for (const s of [-1, 1]) {
    add(M.arm, chain(rm, T(s * (EX - 0.004), YC + 0.02, 0.02), RZ(s * (-0.14) + s * sway * 0.4), RX(-0.06)));
    add(M.foot, chain(rm, T(s * 0.075, 0.03 + bob, 0.045), RX(Math.PI / 2 - 0.12), RZ(-s * 0.25)));
  }
  return { parts, R, boxM, phi, w };
}

// ---------- Renderer ----------
export function createScene(canvas) {
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas");
  const octx = off.getContext("2d");
  let W = 0, H = 0, img = null, px = null, zb = null;
  let sxA = new Float32Array(4096), syA = new Float32Array(4096), izA = new Float32Array(4096);
  let nxA = new Float32Array(4096), nyA = new Float32Array(4096), nzA = new Float32Array(4096);
  let cssW = 1, cssH = 1;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    cssW = Math.max(1, canvas.clientWidth); cssH = Math.max(1, canvas.clientHeight);
    let k = dpr;
    const maxPx = 900000;
    if (cssW * cssH * k * k > maxPx) k = Math.sqrt(maxPx / (cssW * cssH));
    W = Math.max(2, Math.round(cssW * k)); H = Math.max(2, Math.round(cssH * k));
    canvas.width = W; canvas.height = H; off.width = W; off.height = H;
    img = octx.createImageData(W, H);
    px = new Uint32Array(img.data.buffer);
    zb = new Float32Array(W * H);
  }

  // Light directions in view space (x right, y up, z away from camera).
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const LK = norm3([0.5, 0.7, -0.55]), LR = norm3([-0.75, 0.35, 0.6]), LF = norm3([-0.6, 0.1, -0.75]);
  const HV = norm3([LK[0], LK[1], LK[2] - 1]);

  function cam(t) {
    const k = sstep(seg(t, 0, 7));
    const tx = lerp(PX, 0.3, sstep(seg(t, 2.2, 3.4))) + 0.95 * sstep(seg(t, 3.6, 5.0));
    const pos = [tx + lerp(0.3, 1.8, sstep(seg(t, 2.0, 3.5))), 1.0 + 0.2 * k, lerp(4.6, 2.9, k)];
    const tar = [tx, 0.5 + 0.2 * sstep(seg(t, 3.6, 5.0)), 0];
    const f = norm3([tar[0] - pos[0], tar[1] - pos[1], tar[2] - pos[2]]);
    const r = norm3([-f[2], 0, f[0]]);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const aspect = W / H;
    const tanH = Math.tan((38 * Math.PI / 180) / 2) * Math.max(1, 1.6 / aspect);
    return { pos, f, r, u, focal: (H / 2) / tanH };
  }

  function drawMesh(mesh, m, c) {
    const { pos, nor, idx } = mesh, nv = pos.length / 3;
    if (nv > sxA.length) {
      sxA = new Float32Array(nv); syA = new Float32Array(nv); izA = new Float32Array(nv);
      nxA = new Float32Array(nv); nyA = new Float32Array(nv); nzA = new Float32Array(nv);
    }
    const [r, u, f] = [c.r, c.u, c.f], cx = W / 2, cy = H / 2;
    for (let i = 0; i < nv; i++) {
      const o = i * 3, X = pos[o], Y = pos[o + 1], Z = pos[o + 2];
      const wx = m[0] * X + m[1] * Y + m[2] * Z + m[3] - c.pos[0];
      const wy = m[4] * X + m[5] * Y + m[6] * Z + m[7] - c.pos[1];
      const wz = m[8] * X + m[9] * Y + m[10] * Z + m[11] - c.pos[2];
      const vz = wx * f[0] + wy * f[1] + wz * f[2];
      const iz = 1 / Math.max(vz, 0.05);
      sxA[i] = cx + (wx * r[0] + wy * r[1] + wz * r[2]) * iz * c.focal;
      syA[i] = cy - (wx * u[0] + wy * u[1] + wz * u[2]) * iz * c.focal;
      izA[i] = iz;
      const NX = nor[o], NY = nor[o + 1], NZ = nor[o + 2];
      const wnx = m[0] * NX + m[1] * NY + m[2] * NZ, wny = m[4] * NX + m[5] * NY + m[6] * NZ, wnz = m[8] * NX + m[9] * NY + m[10] * NZ;
      nxA[i] = (wnx * r[0] + wny * r[1] + wnz * r[2]) * iz;
      nyA[i] = (wnx * u[0] + wny * u[1] + wnz * u[2]) * iz;
      nzA[i] = (wnx * f[0] + wny * f[1] + wnz * f[2]) * iz;
    }
    for (let q = 0; q < idx.length; q += 3) {
      const a = idx[q], b = idx[q + 1], d = idx[q + 2];
      const x0 = sxA[a], y0 = syA[a], x1 = sxA[b], y1 = syA[b], x2 = sxA[d], y2 = syA[d];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area > -1e-6 && area < 1e-6) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) continue;
      const ia = 1 / area, iz0 = izA[a], iz1 = izA[b], iz2 = izA[d];
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const pxx = x + 0.5;
          const w0 = ((x1 - pxx) * (y2 - py) - (x2 - pxx) * (y1 - py)) * ia;
          const w1 = ((x2 - pxx) * (y0 - py) - (x0 - pxx) * (y2 - py)) * ia;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
          const iz = w0 * iz0 + w1 * iz1 + w2 * iz2, p = y * W + x;
          if (iz <= zb[p]) continue;
          if (!mesh.glass) zb[p] = iz;
          let nx = w0 * nxA[a] + w1 * nxA[b] + w2 * nxA[d];
          let ny = w0 * nyA[a] + w1 * nyA[b] + w2 * nyA[d];
          let nz = w0 * nzA[a] + w1 * nzA[b] + w2 * nzA[d];
          const il = 1 / (Math.hypot(nx, ny, nz) || 1); nx *= il; ny *= il; nz *= il;
          const dk = Math.max(0, nx * LK[0] + ny * LK[1] + nz * LK[2]);
          const dr = Math.max(0, nx * LR[0] + ny * LR[1] + nz * LR[2]);
          const df = Math.max(0, nx * LF[0] + ny * LF[1] + nz * LF[2]);
          const sp = Math.pow(Math.max(0, nx * HV[0] + ny * HV[1] + nz * HV[2]), 36) * 0.3;
          const fr = Math.pow(1 - Math.max(0, -nz), 3) * 0.22;
          if (mesh.glass) { // glass: milky centre, bright fresnel rim, crisp highlights, blended over what is behind
            const fa = Math.abs(nz), rim = Math.pow(1 - fa, 2.2);
            const side = nz < 0 ? 1 : 0.55;
            const hl = Math.pow(Math.max(0, nx * HV[0] + ny * HV[1] + nz * HV[2]), 60) * 0.9;
            const sa = clamp((0.34 + 0.6 * rim) * side * (mesh.boost ? 1.35 : 1) + hl * 0.5);
            const sv = clamp(0.82 + 0.18 * rim + hl + dk * 0.08);
            const da = (px[p] >>> 24) / 255, dv = (px[p] & 255) / 255;
            const oa = sa + da * (1 - sa);
            const ov = (sv * sa + dv * da * (1 - sa)) / (oa || 1);
            const gg = (clamp(ov) * 255) | 0;
            px[p] = (((oa * 255) | 0) << 24) | (gg << 16) | (gg << 8) | gg;
            continue;
          }
          let v = 0.14 + ny * 0.05 + dk * 0.78 + dr * 0.3 + df * 0.16 + sp + fr;
          v = Math.pow(clamp(v), 0.85) * (mesh.tone == null ? 1 : mesh.tone);
          const g = (v * 255) | 0;
          px[p] = 0xff000000 | (g << 16) | (g << 8) | g;
        }
      }
    }
  }

  function project(c, x, y, z) {
    const wx = x - c.pos[0], wy = y - c.pos[1], wz = z - c.pos[2];
    const vz = wx * c.f[0] + wy * c.f[1] + wz * c.f[2], iz = 1 / Math.max(vz, 0.05);
    return [W / 2 + (wx * c.r[0] + wy * c.r[1] + wz * c.r[2]) * iz * c.focal, H / 2 - (wx * c.u[0] + wy * c.u[1] + wz * c.u[2]) * iz * c.focal];
  }
  function blob(c, x, z, rad, alpha, color) {
    const p = project(c, x, 0, z), a = project(c, x - rad, 0, z), b = project(c, x + rad, 0, z);
    const e = project(c, x, 0, z - rad), g = project(c, x, 0, z + rad);
    const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(g[1] - e[1]) / 2;
    if (rx < 1 || ry < 1) return;
    ctx.save();
    ctx.translate(p[0], p[1]); ctx.scale(1, ry / rx);
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, `rgba(${color},${alpha})`);
    gr.addColorStop(0.55, `rgba(${color},${alpha * 0.45})`);
    gr.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const TAU = Math.PI * 2;
  const rnd = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  function drawEnv(c, t) {
    const hz = clamp(project(c, c.pos[0], 0, -40)[1], H * 0.3, H * 0.8);
    // wall + floor, grey scale only
    let g = ctx.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, "#161617"); g.addColorStop(1, "#4a4a4d");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, hz);
    g = ctx.createLinearGradient(0, hz, 0, H);
    g.addColorStop(0, "#58585b"); g.addColorStop(1, "#1d1d1f");
    ctx.fillStyle = g; ctx.fillRect(0, hz, W, H - hz);
    // backdrop: soft vertical panels + big halo rings
    const off0 = c.pos[0] * 0.5;
    for (let i = -8; i < 14; i++) {
      const x = ((i * 0.55 - off0 * 0.0) - c.pos[0] * 0.0), p0 = project(c, x, 0, -3.2), p1 = project(c, x + 0.5, 0, -3.2);
      if (p1[0] < 0 || p0[0] > W) continue;
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.07)";
      ctx.fillRect(p0[0], 0, p1[0] - p0[0], hz);
    }
    const hc = project(c, c.pos[0] * 0.6 + 0.4, 1.0, -3.2);
    for (let i = 0; i < 4; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.12 - i * 0.025})`; ctx.lineWidth = Math.max(1, H * 0.004);
      ctx.beginPath(); ctx.arc(hc[0], hc[1], H * (0.3 + i * 0.12), 0, TAU); ctx.stroke();
    }
    g = ctx.createRadialGradient(hc[0], hc[1], 0, hc[0], hc[1], H * 0.7);
    g.addColorStop(0, "rgba(255,255,255,0.28)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, hz);
    // floor grid in perspective
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,0.10)";
    const gx0 = Math.floor(c.pos[0] - 6);
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) { const x = gx0 + i * 0.75, a = project(c, x, 0, 3), b = project(c, x, 0, -3.2); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    for (let k = 0; k < 9; k++) { const z = 2.4 - k * 0.65, a = project(c, c.pos[0] - 8, 0, z), b = project(c, c.pos[0] + 8, 0, z); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
    ctx.stroke();
    // floor spotlight pool
    const sp = project(c, c.pos[0] * 0.9 + 0.2, 0, 0);
    ctx.save(); ctx.translate(sp[0], sp[1]); ctx.scale(1, 0.32);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.45);
    g.addColorStop(0, "rgba(255,255,255,0.35)"); g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, W * 0.45, 0, TAU); ctx.fill(); ctx.restore();
    // spotlight cones from the top
    for (const [fx, w0] of [[0.22, 0.1], [0.5, 0.14], [0.78, 0.1]]) {
      g = ctx.createLinearGradient(0, 0, 0, hz);
      g.addColorStop(0, "rgba(255,255,255,0.10)"); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.beginPath();
      ctx.moveTo(W * fx - W * 0.012, 0); ctx.lineTo(W * fx + W * 0.012, 0);
      ctx.lineTo(W * (fx + (fx - 0.5) * 0.4 + w0), hz); ctx.lineTo(W * (fx + (fx - 0.5) * 0.4 - w0), hz); ctx.fill();
    }
    // bunting: two swags of white / grey flags
    const flag = (x, y, sz, shade) => {
      ctx.fillStyle = shade; ctx.beginPath(); ctx.moveTo(x - sz * 0.5, y); ctx.lineTo(x + sz * 0.5, y); ctx.lineTo(x, y + sz * 1.05); ctx.closePath(); ctx.fill();
    };
    const shades = ["#ffffff", "#b9b9bd", "#e6e6e8", "#8c8c91"];
    const swag = (x0, x1, y0, sag, nF) => {
      ctx.strokeStyle = "rgba(255,255,255,0.65)"; ctx.lineWidth = Math.max(1, H * 0.003);
      ctx.beginPath(); for (let i = 0; i <= 40; i++) { const u = i / 40, x = lerp(x0, x1, u), y = y0 + sag * Math.sin(Math.PI * u); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
      for (let i = 0; i < nF; i++) { const u = (i + 0.5) / nF, x = lerp(x0, x1, u), y = y0 + sag * Math.sin(Math.PI * u), sw = Math.sin(t * 1.8 + i) * 0.04; ctx.save(); ctx.translate(x, y); ctx.rotate(sw); flag(0, 0, W * 0.032, shades[i % 4]); ctx.restore(); }
    };
    swag(-W * 0.02, W * 0.5, H * 0.015, H * 0.07, 12);
    swag(W * 0.5, W * 1.02, H * 0.015, H * 0.07, 12);
    // string lights (bokeh) near the horizon
    for (let i = 0; i < 18; i++) {
      const x = ((i + 0.5) / 18) * W, y = hz - H * 0.04 + Math.sin(i * 1.7) * H * 0.012, tw = 0.5 + 0.5 * Math.sin(t * 2.2 + i * 1.3);
      g = ctx.createRadialGradient(x, y, 0, x, y, H * 0.025);
      g.addColorStop(0, `rgba(255,255,255,${0.35 + 0.5 * tw})`); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, H * 0.025, 0, TAU); ctx.fill();
    }
    // balloons, bottom corners (white / greys)
    const balloon = (x, y, r, shade, ph) => {
      const by = y + Math.sin(t * 1.3 + ph) * r * 0.12;
      ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, by + r * 1.15); ctx.quadraticCurveTo(x + r * 0.3, by + r * 2.4, x - r * 0.1, by + r * 3.4); ctx.stroke();
      const gg = ctx.createRadialGradient(x - r * 0.35, by - r * 0.4, r * 0.1, x, by, r * 1.2);
      gg.addColorStop(0, "#ffffff"); gg.addColorStop(1, shade);
      ctx.fillStyle = gg; ctx.beginPath(); ctx.ellipse(x, by, r * 0.88, r * 1.1, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = shade; ctx.beginPath(); ctx.moveTo(x, by + r * 1.1); ctx.lineTo(x - r * 0.12, by + r * 1.28); ctx.lineTo(x + r * 0.12, by + r * 1.28); ctx.fill();
    };
    const br = H * 0.055;
    balloon(W * 0.06, H * 0.62, br, "#a8a8ad", 0); balloon(W * 0.115, H * 0.68, br * 0.8, "#6f6f74", 1.5); balloon(W * 0.03, H * 0.74, br * 0.7, "#d8d8db", 3);
    balloon(W * 0.94, H * 0.64, br, "#d0d0d4", 2); balloon(W * 0.885, H * 0.7, br * 0.8, "#85858a", 0.7); balloon(W * 0.972, H * 0.76, br * 0.7, "#ffffff", 4);
    // drifting confetti / sparkles
    for (let i = 0; i < 46; i++) {
      const sp_ = 0.015 + rnd(i + 5) * 0.03, x = (rnd(i) * W + Math.sin(t * 0.7 + i) * W * 0.01), y = ((rnd(i + 9) + t * sp_) % 1) * H, r = H * (0.003 + rnd(i + 2) * 0.006);
      ctx.fillStyle = `rgba(255,255,255,${0.2 + rnd(i + 3) * 0.5})`;
      if (i % 3 === 0) { ctx.save(); ctx.translate(x, y); ctx.rotate(t + i); ctx.fillRect(-r * 1.2, -r * 0.6, r * 2.4, r * 1.2); ctx.restore(); }
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
    }
    // soft vignette
    g = ctx.createRadialGradient(W / 2, H * 0.5, H * 0.35, W / 2, H * 0.5, H * 1.05);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // floor shadows for the box
    const drop = 1 - sstep(seg(t, 0.05, 1.0)), tip = sstep(seg(t, 2.35, 3.0));
    ctx.globalAlpha = sstep(seg(t, 0, 0.9));
    blob(c, lerp(PX, PX + HW + 0.4, tip), 0, 0.8 + drop * 0.3, 0.8 * (1 - drop * 0.7), "0,0,0");
    if (t > 3.3) blob(c, scRx, 0, 0.35, 0.5, "0,0,0");
    ctx.globalAlpha = 1;
  }

  function drawBanner(t) {
    const k = backOut(seg(t, 0.25, 1.25));
    if (k <= 0) return;
    const bw = Math.min(W * 0.74, H * 1.05), bh = bw * 0.2, rope = H * 0.13;
    const cx = W / 2, top = -H * 0.02 + (k - 1) * H * 0.4 + H * 0.115 + rope * 0.0;
    const sw = Math.sin(t * 1.6) * 0.035 * (1 - sstep(seg(t, 5.8, 7)) * 0.5), L = rope + bh * 0.1;
    const a1 = [cx - bw * 0.36, -2], a2 = [cx + bw * 0.36, -2];
    ctx.save();
    ctx.globalAlpha = 1;
    const ox = Math.sin(sw) * L;
    ctx.translate(ox, 0);
    const y0 = top + rope * 0.45;
    // ropes
    ctx.strokeStyle = "rgba(235,235,238,0.9)"; ctx.lineWidth = Math.max(1.5, H * 0.003);
    ctx.beginPath(); ctx.moveTo(a1[0] - ox, a1[1]); ctx.lineTo(a1[0], y0); ctx.moveTo(a2[0] - ox, a2[1]); ctx.lineTo(a2[0], y0); ctx.stroke();
    // pins
    ctx.fillStyle = "#c9c9cd"; for (const a of [a1, a2]) { ctx.beginPath(); ctx.arc(a[0] - ox, 3, H * 0.007, 0, TAU); ctx.fill(); }
    ctx.translate(cx, y0); ctx.rotate(sw);
    const x0 = -bw / 2, nt = bh * 0.22;
    ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = H * 0.03; ctx.shadowOffsetY = H * 0.012;
    ctx.fillStyle = "#ffffff"; ctx.beginPath();
    ctx.moveTo(x0, 0); ctx.lineTo(-x0, 0); ctx.lineTo(-x0 - nt * 0.2, bh * 0.5); ctx.lineTo(-x0, bh); ctx.lineTo(x0, bh); ctx.lineTo(x0 - nt * 0.2 + nt * 0.4, bh * 0.5); ctx.closePath(); ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "#b5b5ba"; ctx.setLineDash([H * 0.012, H * 0.008]); ctx.lineWidth = Math.max(1, H * 0.003);
    ctx.strokeRect(x0 + bw * 0.03, bh * 0.14, bw * 0.94, bh * 0.72); ctx.setLineDash([]);
    ctx.fillStyle = "#7d7d82"; for (const a of [[x0 + bw * 0.07, 0], [-x0 - bw * 0.07, 0]]) { ctx.beginPath(); ctx.arc(a[0], bh * 0.08, H * 0.006, 0, TAU); ctx.fill(); }
    // handwriting
    const txt = "welcome from fidex bot";
    let fs = bh * 0.5; ctx.font = `${fs}px "FidexHand", "Segoe Script", "Bradley Hand", cursive`;
    const mw = ctx.measureText(txt).width, maxw = bw * 0.84; if (mw > maxw) fs *= maxw / mw;
    ctx.font = `${fs}px "FidexHand", "Segoe Script", "Bradley Hand", cursive`;
    ctx.fillStyle = "#2b2b2e"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(txt, 0, bh * 0.52);
    ctx.restore();
  }

  let scRx = 0;
  function render(t) {
    if (!img) resize();
    const c = cam(t);
    const sc = buildScene(t); scRx = sc.R.x;
    zb.fill(0); px.fill(0);
    for (const pass of [0, 1, 2])
      for (const [mesh, m] of sc.parts) if ((mesh.late ? 2 : mesh.glass ? 1 : 0) === pass) drawMesh(mesh, m, c);
    octx.putImageData(img, 0, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    drawEnv(c, t);
    const fadeIn = sstep(seg(t, 0, 0.9));
    ctx.globalAlpha = fadeIn;
    const drop = 1 - sstep(seg(t, 0.05, 1.0)), tip = sstep(seg(t, 2.35, 3.0));
    blob(c, lerp(PX, PX + HW + 0.4, tip), 0, 0.8 + drop * 0.3, 0.8 * (1 - drop * 0.7), "0,0,0");
    if (t > 3.3) blob(c, sc.R.x, 0, 0.3, 0.4, "0,0,0");
    // Light spilling out of the opened box.
    const spill = sstep(seg(t, 3.0, 3.6)) * (1 - sstep(seg(t, 4.6, 5.6)));
    if (spill > 0) {
      const p = project(c, PX + HW + BH + 0.1, 0.5, 0);
      ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(1.5, 0.8);
      const rr = H * 0.3;
      const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
      g2.addColorStop(0, `rgba(255,255,255,${0.45 * spill})`);
      g2.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.fill();
      ctx.restore(); ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = fadeIn;
    ctx.filter = "blur(0.55px)";
    ctx.drawImage(off, 0, 0);
    ctx.filter = "none";

    // Reveal glow behind the raised robot.
    const gl = sstep(seg(t, 4.8, 5.6));
    if (gl > 0) {
      const p = project(c, sc.R.x, sc.R.y, 0);
      const rad = H * 0.5;
      const gr = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad);
      gr.addColorStop(0, `rgba(255,255,255,${0.2 * gl})`);
      gr.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    }
    drawBanner(t);
    // Fade to black at the end.
    const out = sstep(seg(t, 6.45, 6.98));
    if (out > 0) { ctx.globalAlpha = out; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
    ctx.globalAlpha = 1;
  }

  return { render, resize };
}

// ---------- Playback ----------
let styled = false;
function injectStyle() {
  if (styled) return; styled = true;
  try {
    const ff = new FontFace("FidexHand", `url(${HAND_FONT})`);
    ff.load().then((f) => document.fonts.add(f)).catch(() => {});
  } catch (err) { /* falls back to the system cursive font */ }
  const st = document.createElement("style");
  st.textContent = `#intro-title{font-family:"FidexHand","Segoe Script","Bradley Hand",cursive !important;text-transform:lowercase !important;
    font-size:clamp(13px,2.1vw,20px) !important;letter-spacing:.06em !important;font-weight:400 !important;padding-left:0 !important;color:#ececee !important;
    text-shadow:0 1px 10px rgba(0,0,0,.6) !important}`;
  document.head.appendChild(st);
}
export function playIntro({ canvas, titleEl, duration = 7000, onEnd }) {
  injectStyle();
  const scene = createScene(canvas);
  let raf = 0, stopped = false;
  const start = performance.now();
  const onResize = () => scene.resize();
  window.addEventListener("resize", onResize);
  scene.resize();
  const t1 = setTimeout(() => titleEl.classList.add("on"), 700);
  const t2 = setTimeout(() => titleEl.classList.add("off"), duration - 600);

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    clearTimeout(t1); clearTimeout(t2);
    window.removeEventListener("resize", onResize);
  }
  function frame(now) {
    if (stopped) return;
    const ms = now - start;
    if (ms >= duration) { scene.render(7); stop(); onEnd(); return; }
    scene.render(ms / 1000);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return stop;
}
