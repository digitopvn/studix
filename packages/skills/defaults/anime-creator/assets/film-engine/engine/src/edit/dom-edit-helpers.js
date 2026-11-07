// The DOM side of the edit on one paused GSAP timeline. Camera moves go on #cam (videos and the GL canvas
// move together, so FX stay locked to the footage), deterministic shake on #shaker, whip blur on the SVG
// filter, anime impact frames on #fx, flashes and colour tints on full-frame layers. HyperFrames cuts the
// <video> clips itself by data-start / data-duration; this timeline only adds the craft on top. The camera rig
// (handheld, sway, crash/snap zoom, whip pan, dutch, rack focus) stacks on top as pure functions of t.
import { SHOTS, FPS, DURATION, W, H, rng } from "../core/film-constants.js";
import { createCameraRig, rotCover } from "./camera-rig.js";

export function createEditKit(gsap) {
  const tl = gsap.timeline({ paused: true });
  const F = 1 / FPS;
  const S = Object.fromEntries(SHOTS.map((s) => [s.id, s]));
  const at = (id, off = 0) => S[id].start + off;
  const len = (id) => S[id].end - S[id].start;

  // shake on #shaker: amplitude in px, decays (or grows when decay < 0), settles to 0 at the end. `cover` scales the
  // frame just enough to keep its edges out of view, for a shake with no camera overscan under it. The scale follows
  // the amplitude envelope frame by frame (not each random step, which pumps the zoom) and eases in and out over 4
  // frames, so a shake that starts on a still frame does not step the zoom. The shake itself rides the same ease, so
  // it never travels further than the zoom covers at that frame. `snap` starts at full strength instead, for a hit
  // whose flash frame hides the step.
  const shake = (t0, dur, amp, { freq = 30, rot = 0.5, decay = 2.5, seed = 1, cover = false, snap = false } = {}) => {
    const r = rng(seed), n = Math.max(2, Math.round(dur * freq)), kf = [], ramp = Math.min(4 * F, dur / 2);
    const ease = (t) => {
      if (!cover) return 1;
      const g = Math.max(0, Math.min(1, snap ? 1 : t / ramp, (dur - t) / ramp));
      return g * g * (3 - 2 * g);
    };
    for (let i = 1; i <= n; i++) {
      const a = i === n ? 0 : amp * Math.exp((-decay * i) / n) * ease((i * dur) / n);
      kf.push({ x: r() * a, y: r() * a * 0.8, rotation: (r() * rot * a) / amp, duration: dur / n, ease: "none" });
    }
    tl.to("#shaker", { keyframes: kf }, t0);
    if (!cover) return;
    const m = Math.max(2, Math.round(dur / F)), sk = [];
    for (let j = 1; j <= m; j++) {
      const t = (j * dur) / m, a = amp * Math.exp((-decay * t) / dur) * ease(t);
      sk.push({ scale: 1 + (2 * a) / W + (1.6 * a) / H + rotCover(rot * (a / amp)), duration: dur / m, ease: "none" });
    }
    tl.fromTo("#shaker", { scale: 1 }, { keyframes: sk, immediateRender: false }, t0);
  };
  // camera on #cam for one shot: from -> to {scale, x, y, rotation}; off/dur trim the move inside the shot
  const cam = (id, from = {}, to = {}, ease = "none", off = 0, dur = null) =>
    tl.fromTo("#cam", { scale: 1, x: 0, y: 0, rotation: 0, ...from }, { scale: 1, x: 0, y: 0, rotation: 0, ...to, duration: dur ?? len(id) - off, ease, immediateRender: false }, at(id, off));
  // a full-frame DOM layer laid out over a cel shot rides its GL push: scaled with the cel's zoom about the same focus,
  // linear like the push (cel: the shot's scene-config entry, { zoom, focus }); the layer must sit inside #cam
  const followCel = (sel, id, { zoom, focus }) =>
    tl.fromTo(sel, { scale: 1, transformOrigin: `${focus[0] * W}px ${(1 - focus[1]) * H}px` },
      { scale: zoom[1] / zoom[0], duration: len(id), ease: "none", immediateRender: false }, at(id));
  const flash = (t, peak, dur, ease = "power2.out") => tl.fromTo("#flash", { opacity: peak }, { opacity: 0, duration: dur, ease, immediateRender: false }, t);
  const tint = (t, peak, dur, color) => tl.set("#tint", { backgroundColor: color }, t).fromTo("#tint", { opacity: peak }, { opacity: 0, duration: dur, ease: "power1.out", immediateRender: false }, t);
  // anime impact frame: negative, high contrast, for n frames (2-3 frames at 24 fps reads as a hit, more strobes)
  const impact = (t, n = 2) => tl.set("#fx", { filter: "invert(1) grayscale(1) contrast(1.9)" }, t).set("#fx", { filter: "none" }, t + n * F);
  // horizontal whip blur into a cut
  const whipIn = (t, px = 70, dur = 0.1) => tl.fromTo("#whip", { attr: { stdDeviation: `${px} 0` } }, { attr: { stdDeviation: "0 0" }, duration: dur, ease: "power2.out", immediateRender: false }, t);
  // show an element over [t0, t1] (captions, inserts, labels)
  const show = (sel, t0, t1, { rise = 8, fadeIn = 0.12, fadeOut = 0.1 } = {}) =>
    tl.fromTo(sel, { autoAlpha: 0, y: rise }, { autoAlpha: 1, y: 0, duration: fadeIn, ease: "power2.out", immediateRender: false }, t0)
      .to(sel, { autoAlpha: 0, duration: fadeOut, ease: "power1.in" }, t1 - fadeOut);
  const title = (t, dur = 0.55) => tl.fromTo("#title", { autoAlpha: 0, scale: 1.06, filter: "blur(10px)" }, { autoAlpha: 1, scale: 1, filter: "blur(0px)", duration: dur, ease: "power2.out", immediateRender: false }, t);
  const fadeFromBlack = (dur = 0.35) => (dur > 0 ? tl.fromTo("#black", { opacity: 1 }, { opacity: 0, duration: dur, ease: "power1.out" }, 0) : tl.set("#black", { opacity: 0 }, 0));
  const fadeToBlack = (dur = 0.3) => dur > 0 && tl.fromTo("#black", { opacity: 0 }, { opacity: 1, duration: dur, ease: "power1.in", immediateRender: false }, DURATION - dur);
  // a full hit: impact frame + flash + heavy shake (+ optional colour tint), the most reused beat in a fight
  const hit = (t, { frames = 2, flashPeak = 0.85, flashDur = 0.12, amp = 22, dur = 0.45, seed = 41, color = null, cover = false } = {}) => {
    impact(t, frames); flash(t, flashPeak, flashDur); shake(t, dur, amp, { decay: 3, rot: 1.1, seed, cover, snap: true });
    if (color) tint(t + F * 2, 0.28, 0.3, color);
  };

  // character name card: an accent bar grows, the name wipes on with a 3-frame RGB split, a mono tag above and the
  // role below, then it all slides out. Cards are built only when a scene calls this, so other scenes are untouched.
  const nameCard = (t, { name, role = "", tag = "", color = "#ffb35c", dur = 2.4, side = "left", y = 0.14 } = {}) => {
    const el = cardNode(`<i class="bar"></i><div class="tx"><span class="tag">${tag}</span><b class="nm">${name}</b><i class="ln"></i><span class="rl">${role}</span></div>`,
      `nc ${side}`, color);
    el.style.top = `${y * 100}%`;
    const q = (s) => el.querySelector(s), ac = color;
    // the delayed fromTo tweens below do not render before they start, so pin every part's hidden state at t
    // first; otherwise the whole card shows for a few frames, vanishes, then animates in
    tl.set(q(".bar"), { scaleY: 0 }, t).set([q(".tag"), q(".rl")], { autoAlpha: 0 }, t)
      .set(q(".nm"), { clipPath: "inset(0 100% 0 0)" }, t).set(q(".ln"), { scaleX: 0 }, t)
      .set(el, { autoAlpha: 1 }, t)
      .fromTo(q(".bar"), { scaleY: 0 }, { scaleY: 1, duration: 0.22, ease: "power3.out", immediateRender: false }, t)
      .fromTo(q(".tag"), { autoAlpha: 0, letterSpacing: "0.7em" }, { autoAlpha: 1, letterSpacing: "0.32em", duration: 0.35, ease: "power2.out", immediateRender: false }, t + 0.06)
      .fromTo(q(".nm"), { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 0.3, ease: "power3.out", immediateRender: false }, t + 0.1)
      .set(q(".nm"), { textShadow: `-9px 0 0 rgba(255,40,90,.85), 9px 0 0 rgba(40,220,255,.85), 0 0 30px ${ac}` }, t + 0.1)
      .set(q(".nm"), { textShadow: `-4px 0 0 rgba(255,40,90,.7), 4px 0 0 rgba(40,220,255,.7), 0 0 30px ${ac}` }, t + 0.1 + F)
      .set(q(".nm"), { textShadow: `0 0 26px ${ac}, 0 4px 14px rgba(0,0,0,.75)` }, t + 0.1 + 3 * F)
      .fromTo(q(".ln"), { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: "power2.out", immediateRender: false }, t + 0.22)
      .fromTo(q(".rl"), { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out", immediateRender: false }, t + 0.32)
      .to(el, { autoAlpha: 0, x: side === "left" ? -40 : 40, filter: "blur(6px)", duration: 0.28, ease: "power2.in" }, t + dur - 0.28);
  };
  // end-of-episode card on black: the line draws, the title settles out of a blur, the teaser follows
  const endCard = (t, { title: t1 = "HẾT TẬP 1", sub = "Đón xem tập 2", color = "#ff8a3d", dur = 2.4 } = {}) => {
    const el = cardNode(`<b class="nm">${t1}</b><i class="ln"></i><span class="rl">${sub}</span>`, "ec", color);
    const q = (s) => el.querySelector(s);
    tl.set([q(".nm"), q(".rl")], { autoAlpha: 0 }, t).set(q(".ln"), { scaleX: 0 }, t)
      .set(el, { autoAlpha: 1 }, t)
      .fromTo(q(".nm"), { autoAlpha: 0, scale: 1.08, filter: "blur(12px)", letterSpacing: "0.5em" },
        { autoAlpha: 1, scale: 1, filter: "blur(0px)", letterSpacing: "0.22em", duration: 0.6, ease: "power3.out", immediateRender: false }, t)
      .fromTo(q(".ln"), { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power2.inOut", immediateRender: false }, t + 0.2)
      .fromTo(q(".rl"), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: "power2.out", immediateRender: false }, t + 0.55)
      .to(el, { autoAlpha: 0, duration: 0.3, ease: "power1.in" }, t + dur - 0.3);
  };

  tl.set("#cam", { scale: 1, x: 0, y: 0, rotation: 0 }, 0);
  return { tl, gsap, F, S, at, len, shake, cam, followCel, flash, tint, impact, whipIn, show, sub: show, title, hit, fadeFromBlack, fadeToBlack,
    nameCard, endCard, ...createCameraRig() };
}

// Card DOM sits over the vignette and under #black, with its own fonts (the scene's assets/fonts) and a warm-up span
// that keeps every card font in use from the first frame, so no render worker draws a card in a fallback face.
const CARD_CSS = `
@font-face { font-family: "Card Serif"; src: url("assets/fonts/SourceSerif4.ttf") format("truetype"); font-weight: 200 900; font-display: block; }
@font-face { font-family: "Card Mono"; src: url("assets/fonts/ShareTechMono-Regular.ttf") format("truetype"); font-display: block; }
@font-face { font-family: "Card Sans"; src: url("assets/fonts/BeVietnamPro-SemiBold.ttf") format("truetype"); font-weight: 600; font-display: block; }
.nc, .ec { position: absolute; visibility: hidden; opacity: 0; pointer-events: none; z-index: 5; }
.nc { left: 130px; padding-left: 34px; }
.nc.right { left: auto; right: 130px; padding: 0 34px 0 0; text-align: right; }
.nc .bar { position: absolute; left: 0; top: 4px; bottom: 4px; width: 7px; background: var(--ac); box-shadow: 0 0 18px var(--ac); transform-origin: 50% 0; }
.nc.right .bar { left: auto; right: 0; }
.nc .tx, .ec { display: flex; flex-direction: column; }
.nc.right .tx { align-items: flex-end; }
/* a scene's own .tag / .tx / .nm / .rl rules must not reach into the cards */
.nc .tag, .nc .nm, .nc .rl, .ec .nm, .ec .rl { position: static; inset: auto; padding: 0; border: 0; background: none; }
.nc .tag { font: 400 26px/1 "Card Mono", monospace; color: var(--ac); letter-spacing: 0.32em; text-transform: uppercase; margin-bottom: 10px;
  text-shadow: 0 2px 8px rgba(0,0,0,.8); }
.nc .nm { font: 900 128px/0.95 "Card Serif", serif; color: #fff; letter-spacing: 0.01em; text-shadow: 0 0 26px var(--ac), 0 4px 14px rgba(0,0,0,.75); }
.nc .ln, .ec .ln { display: block; align-self: stretch; height: 3px; margin: 14px 0 12px; background: linear-gradient(90deg, var(--ac), rgba(255,255,255,0)); transform-origin: 0 50%; }
.nc.right .ln { background: linear-gradient(270deg, var(--ac), rgba(255,255,255,0)); transform-origin: 100% 50%; }
.nc .rl { font: 600 36px/1.2 "Card Sans", sans-serif; color: #f6f2ec; -webkit-text-stroke: 6px #05070d; paint-order: stroke fill; }
.ec { inset: 0; align-items: center; justify-content: center; text-align: center; }
.ec .nm { font: 800 112px/1 "Card Serif", serif; color: #fff4ea; letter-spacing: 0.22em; padding-left: 0.22em; text-shadow: 0 0 34px var(--ac); }
.ec .ln { align-self: center; width: 520px; margin: 26px 0 22px; background: linear-gradient(90deg, rgba(255,255,255,0), var(--ac), rgba(255,255,255,0)); transform-origin: 50% 50%; }
.ec .rl { font: 600 44px/1.2 "Card Sans", sans-serif; color: #f1e6dc; letter-spacing: 0.08em; }
.card-warm { position: absolute; left: 0; top: 0; opacity: 0.001; font-size: 8px; color: #000; }
.card-warm b { font-family: "Card Serif"; font-weight: 900; } .card-warm i { font-family: "Card Mono"; } .card-warm u { font-family: "Card Sans"; }
`;
function cardNode(html, cls, color) {
  const root = document.getElementById("root"), black = document.getElementById("black");
  if (!document.getElementById("card-css")) {
    const st = document.createElement("style");
    st.id = "card-css"; st.textContent = CARD_CSS; document.head.appendChild(st);
    const warm = document.createElement("div");
    warm.className = "card-warm"; warm.innerHTML = "<b>Aă</b><i>A</i><u>Aă</u>";
    root.appendChild(warm);
  }
  const el = document.createElement("div");
  el.className = cls; el.style.setProperty("--ac", color); el.innerHTML = html;
  (black?.parentNode || root).insertBefore(el, black || null);
  return el;
}
