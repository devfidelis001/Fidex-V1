// FIDEX AI first-run intro: the box opens, the robot rises out, floats, blinks and says hello.
// Pure CSS animation (intro-image.css); this module builds the scene and reports the end.
const ROBOT = new URL("../assets/fidex-robot.png", import.meta.url).href;

export function playIntro({ imgEl, titleEl, duration = 9000, onEnd }) {
  const view = imgEl.closest(".fr-intro");
  const stage = imgEl;
  stage.className = "fx-stage";
  let sparks = "";
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
    const d = 38 + Math.random() * 30;
    sparks += `<i style="--dx:${(Math.cos(a) * d).toFixed(1)}%;--dy:${(Math.sin(a) * d - 20).toFixed(1)}%;--s:${(0.5 + Math.random()).toFixed(2)}"></i>`;
  }
  stage.innerHTML =
    `<div class="fx-glow"></div>` +
    `<div class="fx-box">` +
    `<div class="fx-inside"></div>` +
    `<div class="fx-robot"><div class="fx-bob"><img src="${ROBOT}" alt="" draggable="false">` +
    `<b class="fx-lid fx-l"></b><b class="fx-lid fx-r"></b></div></div>` +
    `<div class="fx-front"><span class="fx-tape"></span></div>` +
    `<div class="fx-flap fx-fl"></div><div class="fx-flap fx-fr"></div>` +
    `</div>` +
    `<div class="fx-sparks">${sparks}</div>`;
  view.classList.remove("fx-play");
  void view.offsetWidth;
  view.classList.add("fx-play");
  let ended = false;
  const timer = setTimeout(() => { ended = true; onEnd(); }, duration);
  return () => { ended = true; clearTimeout(timer); };
}
