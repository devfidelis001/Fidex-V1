// FIDEX AI first-run intro: the glass F-bot is unboxed under a hanging welcome banner.
// Self-contained: one SVG scene built from a string + CSS animations in first-run.css.
// No libraries, no image/font files, no inline style attributes (the app CSP is style-src 'self').
// Contract with first-run.js is unchanged: playIntro({ canvas, titleEl, duration, onEnd }) returns a stop() function.

const TOTAL_MS = 10500; // long enough for the handwriting to finish

const BODY = "M0,-250 C112,-250 186,-150 191,-8 C196,122 168,232 90,246 C30,254 -30,254 -90,246 C-168,232 -196,122 -191,-8 C-186,-150 -112,-250 0,-250 Z";
const LEAF = "M-98,0 C-48,-33 48,-33 98,0 C48,33 -48,33 -98,0 Z";

function bunting(p0, c, p1, n) {
  let out = "";
  const pt = (t) => [
    (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
    (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1],
  ];
  out += `<path d="M${p0[0]},${p0[1]} Q${c[0]},${c[1]} ${p1[0]},${p1[1]}" fill="none" stroke="#9a9ea6" stroke-width="3"/>`;
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1), [x, y] = pt(t), [x2, y2] = pt(t + 0.01);
    const a = (Math.atan2(y2 - y, x2 - x) * 180) / Math.PI;
    const fill = i % 2 ? "#ffffff" : "#b9bdc4";
    out += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(1)})"><polygon points="-26,0 26,0 0,62" fill="${fill}" stroke="#8d9199" stroke-width="2" stroke-linejoin="round"/></g>`;
  }
  return out;
}

function lantern(x, y, len) {
  return (
    `<g transform="translate(${x} ${y})"><g class="fx-swing">` +
    `<line x1="0" y1="${-len}" x2="0" y2="-58" stroke="#9a9ea6" stroke-width="3"/>` +
    `<ellipse cx="0" cy="0" rx="56" ry="62" fill="url(#fxLantern)" stroke="#aeb2b9" stroke-width="2"/>` +
    `<ellipse cx="0" cy="0" rx="34" ry="62" fill="none" stroke="#c4c7cd" stroke-width="2"/>` +
    `<ellipse cx="0" cy="0" rx="12" ry="62" fill="none" stroke="#c4c7cd" stroke-width="2"/>` +
    `<rect x="-14" y="-66" width="28" height="9" rx="3" fill="#8d9199"/><rect x="-14" y="57" width="28" height="9" rx="3" fill="#8d9199"/>` +
    `</g></g>`
  );
}

function star(x, y, s, fill) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? s * 0.42 : s, a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push((x + r * Math.cos(a)).toFixed(1) + "," + (y + r * Math.sin(a)).toFixed(1));
  }
  return `<polygon points="${pts.join(" ")}" fill="${fill}" stroke="#b3b7be" stroke-width="2" stroke-linejoin="round"/>`;
}

function robotArt() {
  return `
  <!-- ground contact shadow -->
  <ellipse class="fx-shadow" cx="0" cy="288" rx="200" ry="20" fill="#2b2f36" opacity=".2" filter="url(#fxBlurM)"/>
  <g class="fx-float">
    <!-- soft halo -->
    <path d="${BODY}" fill="#bfe9ff" opacity=".5" filter="url(#fxBlurL)" transform="scale(1.06)"/>

    <!-- arms (behind body) -->
    <g transform="translate(-196 -22)"><g class="fx-arm fx-arm-l"><g transform="rotate(9)">
      <rect x="-19" y="-6" width="38" height="158" rx="19" fill="url(#fxArm)" stroke="#fff" stroke-width="3.5"/>
      <rect x="-19" y="-6" width="38" height="158" rx="19" fill="none" stroke="#bfe9ff" stroke-width="9" opacity=".55" filter="url(#fxBlurS)"/>
      <path d="M-9,14 L-9,118" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".75" filter="url(#fxBlurXS)"/>
    </g></g></g>
    <g transform="translate(196 -22)"><g class="fx-arm fx-arm-r"><g transform="rotate(-9)">
      <rect x="-19" y="-6" width="38" height="158" rx="19" fill="url(#fxArm)" stroke="#fff" stroke-width="3.5"/>
      <rect x="-19" y="-6" width="38" height="158" rx="19" fill="none" stroke="#bfe9ff" stroke-width="9" opacity=".55" filter="url(#fxBlurS)"/>
      <path d="M-9,14 L-9,118" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".75" filter="url(#fxBlurXS)"/>
    </g></g></g>

    <!-- glass body -->
    <path d="${BODY}" fill="url(#fxBody)"/>
    <g clip-path="url(#fxBodyClip)">
      <!-- back wall of the glass -->
      <rect x="-200" y="-260" width="400" height="520" fill="url(#fxInner)"/>
      <!-- blurred shapes seen through the glass -->
      <g opacity=".34" filter="url(#fxBlurM)" fill="#66717c">
        <rect x="-22" y="30" width="44" height="120" rx="8"/>
        <rect x="-100" y="92" width="200" height="40" rx="10"/>
        <rect x="-62" y="56" width="124" height="34" rx="8"/>
        <rect x="-40" y="-6" width="26" height="60" rx="8" transform="rotate(-18 -27 24)"/>
        <rect x="14" y="-6" width="26" height="60" rx="8" transform="rotate(18 27 24)"/>
      </g>
      <!-- fine scanline texture -->
      <rect x="-200" y="-260" width="400" height="520" fill="url(#fxScan)"/>
      <!-- inner fresnel edge -->
      <path d="${BODY}" fill="none" stroke="#fff" stroke-width="22" opacity=".5" filter="url(#fxBlurM)"/>
      <!-- bottom caustic -->
      <ellipse cx="0" cy="238" rx="120" ry="26" fill="#fff" opacity=".6" filter="url(#fxBlurM)"/>
      <!-- reflections -->
      <path d="M-150,-120 C-176,-60 -178,10 -164,70" fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round" opacity=".6" filter="url(#fxBlurXS)"/>
      <path d="M-128,-176 C-96,-206 -54,-222 -20,-226" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" opacity=".7" filter="url(#fxBlurXS)"/>
      <path d="M158,-60 C170,-10 168,60 150,120" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" opacity=".5" filter="url(#fxBlurXS)"/>
      <rect x="-112" y="-182" width="64" height="26" rx="13" fill="#fff" opacity=".4" transform="rotate(-24 -80 -170)" filter="url(#fxBlurXS)"/>
      <circle cx="-104" cy="-196" r="6" fill="#fff" opacity=".95"/>
    </g>
    <!-- glowing edge -->
    <path d="${BODY}" fill="none" stroke="#c8f0ff" stroke-width="16" opacity=".55" filter="url(#fxBlurM)"/>
    <path d="${BODY}" fill="none" stroke="#fff" stroke-width="5"/>

    <!-- face -->
    <g class="fx-face">
      <g class="fx-eye"><rect x="-108" y="-122" width="52" height="68" rx="15" fill="#0d0e12"/></g>
      <g class="fx-eye"><rect x="56" y="-122" width="52" height="68" rx="15" fill="#0d0e12"/></g>
      <rect x="-30" y="-74" width="60" height="11" rx="5.5" fill="#0d0e12"/>
    </g>

    <!-- leaf-shaped feet -->
    <g transform="translate(-112 232) rotate(34)">
      <path d="${LEAF}" fill="url(#fxLeaf)" stroke="#fff" stroke-width="4"/>
      <path d="${LEAF}" fill="none" stroke="#c8f0ff" stroke-width="12" opacity=".5" filter="url(#fxBlurS)"/>
      <path d="M-70,-8 C-30,-20 30,-20 66,-8" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".8" filter="url(#fxBlurXS)"/>
    </g>
    <g transform="translate(112 232) rotate(-34)">
      <path d="${LEAF}" fill="url(#fxLeaf)" stroke="#fff" stroke-width="4"/>
      <path d="${LEAF}" fill="none" stroke="#c8f0ff" stroke-width="12" opacity=".5" filter="url(#fxBlurS)"/>
      <path d="M-66,-8 C-30,-20 30,-20 70,-8" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".8" filter="url(#fxBlurXS)"/>
    </g>
  </g>`;
}

function sceneMarkup() {
  let sparks = "";
  for (let i = 0; i < 8; i++) sparks += `<circle class="fx-spk" cx="800" cy="560" r="${i % 2 ? 5 : 8}" fill="#fff" stroke="#bfe9ff" stroke-width="3"/>`;
  return `
<svg class="fx-svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="unboxing your f-bot, your ceo">
  <defs>
    <linearGradient id="fxWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e2e4e8"/></linearGradient>
    <linearGradient id="fxFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eceef1"/><stop offset="1" stop-color="#c9ccd2"/></linearGradient>
    <radialGradient id="fxLantern" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d3d6db"/></radialGradient>
    <radialGradient id="fxBody" cx=".5" cy=".42" r=".62">
      <stop offset="0" stop-color="#eaf8ff" stop-opacity=".16"/>
      <stop offset=".6" stop-color="#cfe8f7" stop-opacity=".4"/>
      <stop offset=".88" stop-color="#ffffff" stop-opacity=".7"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity=".95"/>
    </radialGradient>
    <linearGradient id="fxInner" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".25"/>
      <stop offset=".55" stop-color="#b9cfdc" stop-opacity=".18"/>
      <stop offset="1" stop-color="#7f98a8" stop-opacity=".32"/>
    </linearGradient>
    <linearGradient id="fxArm" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".92"/><stop offset=".5" stop-color="#dff1fc" stop-opacity=".3"/><stop offset="1" stop-color="#ffffff" stop-opacity=".85"/>
    </linearGradient>
    <linearGradient id="fxLeaf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".55" stop-color="#d9eefa" stop-opacity=".4"/><stop offset="1" stop-color="#ffffff" stop-opacity=".85"/>
    </linearGradient>
    <radialGradient id="fxBurst" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffffff" stop-opacity=".95"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
    <pattern id="fxScan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1.4" fill="#fff" opacity=".12"/></pattern>
    <filter id="fxBlurXS" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5"/></filter>
    <filter id="fxBlurS" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="fxBlurM" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="fxBlurL" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="26"/></filter>
    <filter id="fxDrop" x="-10%" y="-10%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="8"/><feOffset dy="8"/><feComponentTransfer><feFuncA type="linear" slope=".22"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="fxBodyClip"><path d="${BODY}"/></clipPath>
    <clipPath id="fxRiseClip"><rect class="fx-cliprect" x="-1200" y="-1200" width="4000" height="1760"/></clipPath>
    <clipPath id="fxWriteClip"><rect class="fx-writerect" x="380" y="820" width="840" height="70"/></clipPath>
  </defs>

  <!-- environment: white and grey room -->
  <rect x="-1200" y="-600" width="4000" height="1250" fill="url(#fxWall)"/>
  <circle cx="190" cy="430" r="150" fill="#e8eaed" opacity=".7"/><circle cx="1420" cy="470" r="190" fill="#e8eaed" opacity=".7"/>
  <circle cx="330" cy="560" r="60" fill="#dfe2e6" opacity=".6"/><circle cx="1250" cy="250" r="46" fill="#dfe2e6" opacity=".6"/>
  <rect x="-1200" y="640" width="4000" height="700" fill="url(#fxFloor)"/>
  <rect x="-1200" y="636" width="4000" height="8" fill="#d2d5da"/>
  <ellipse cx="800" cy="790" rx="560" ry="78" fill="#dcdfe3"/><ellipse cx="800" cy="790" rx="500" ry="64" fill="none" stroke="#fff" stroke-width="5" opacity=".8"/>
  ${star(150, 300, 30, "#ffffff")}${star(290, 440, 20, "#c3c6cc")}${star(1450, 300, 26, "#c3c6cc")}${star(1320, 560, 32, "#ffffff")}${star(60, 560, 22, "#c3c6cc")}
  <g class="fx-bunting">${bunting([-160, 10], [170, 170], [470, 40], 6)}${bunting([1130, 40], [1430, 170], [1760, 10], 6)}</g>
  ${lantern(250, 360, 360)}${lantern(1360, 340, 340)}

  <!-- hanging banner -->
  <g class="fx-banner-drop"><g class="fx-banner-sway">
    <line x1="560" y1="-400" x2="560" y2="78" stroke="#8d9199" stroke-width="4"/><line x1="1040" y1="-400" x2="1040" y2="78" stroke="#8d9199" stroke-width="4"/>
    <circle cx="560" cy="78" r="7" fill="#6f747c"/><circle cx="1040" cy="78" r="7" fill="#6f747c"/>
    <g filter="url(#fxDrop)">
      <path d="M520,80 L1080,80 L1080,196 L1045,174 L1010,196 L590,196 L555,174 L520,196 Z" fill="#ffffff" stroke="#c4c7cd" stroke-width="3" stroke-linejoin="round"/>
    </g>
    <path d="M536,94 L1064,94 L1064,168 L1044,156 L1012,176 L588,176 L556,156 L536,168 Z" fill="none" stroke="#c9ccd2" stroke-width="2" stroke-dasharray="8 7"/>
    <text x="800" y="147" text-anchor="middle" font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-size="38" font-weight="500" letter-spacing="2.5" fill="#4a4f57">welcome from fidex bot</text>
  </g></g>

  <!-- unboxing -->
  <g class="fx-box"><g class="fx-box-shake">
    <rect x="590" y="560" width="420" height="200" rx="6" fill="#2a2d33"/>
    <rect x="590" y="560" width="420" height="200" rx="6" fill="url(#fxFloor)" opacity=".0"/>
    <g class="fx-flap fx-flap-l"><polygon points="590,560 800,560 792,512 604,512" fill="#f4f5f7" stroke="#c2c5cb" stroke-width="2"/></g>
    <g class="fx-flap fx-flap-r"><polygon points="1010,560 800,560 808,512 996,512" fill="#e9ebee" stroke="#c2c5cb" stroke-width="2"/></g>
  </g></g>

  <circle class="fx-burst" cx="800" cy="520" r="260" fill="url(#fxBurst)"/>

  <!-- robot (clipped to above the box rim while it rises out) -->
  <g clip-path="url(#fxRiseClip)">
    <g transform="translate(800 488) scale(1.05)"><g class="fx-rise">${robotArt()}</g></g>
  </g>

  <!-- box front drawn after the robot so the robot is "inside" until the clip opens -->
  <g class="fx-box fx-box-front"><g class="fx-box-shake">
    <rect x="590" y="600" width="420" height="160" rx="6" fill="#f6f7f8" stroke="#c9ccd2" stroke-width="3"/>
    <rect x="780" y="600" width="40" height="160" fill="#d9c9a8" opacity=".6"/>
    <rect x="590" y="600" width="420" height="14" fill="#e3e5e8"/>
  </g></g>

  <g class="fx-sparks">${sparks}</g>

  <!-- handwriting -->
  <g clip-path="url(#fxWriteClip)">
    <text class="fx-hand" x="800" y="874" text-anchor="middle" font-family="'Segoe Script','Bradley Hand','Lucida Handwriting','Snell Roundhand','Segoe Print','Comic Sans MS',cursive" font-size="50" fill="#41464e">unboxing your f-bot, your ceo</text>
  </g>
  <path class="fx-underline" d="M430,890 C620,882 980,896 1170,887" fill="none" stroke="#41464e" stroke-width="3" stroke-linecap="round" pathLength="1"/>
</svg>`;
}

export function playIntro({ canvas, titleEl, duration = 7000, onEnd }) {
  const host = canvas.parentElement; // #intro-view
  const old = host.querySelector(".fx-scene");
  if (old) old.remove();
  host.classList.remove("fx-play");
  canvas.hidden = true; // the old canvas renderer is no longer used
  if (titleEl) titleEl.hidden = true; // handwriting is drawn inside the scene

  const scene = document.createElement("div");
  scene.className = "fx-scene";
  scene.innerHTML = sceneMarkup();
  host.insertBefore(scene, host.firstChild);
  void scene.offsetWidth;
  host.classList.add("fx-play");

  let stopped = false;
  const timer = setTimeout(() => {
    if (stopped) return;
    stopped = true;
    onEnd();
  }, Math.max(duration, TOTAL_MS));

  return function stop() {
    stopped = true;
    clearTimeout(timer);
  };
}
