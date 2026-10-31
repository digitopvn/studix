// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/assets/film-engine/engine/src/core/plate-track.js (Studix changes are marked "Studix:").
// Plate tracks: a video clip's own motion (its camera and the subject a region follows), one 2x3 affine per clip
// frame mapping frame-0 px to frame-i px at W x H, written by scripts/track-plate-motion.py into the scene's
// src/scene/plate-tracks.js and handed to the engine as SCENE.tracks. A light FX position read off the clip rides
// the footage through fx.map on a tracked shot; a DOM overlay rides it with pinToTrack. Without a track nothing
// changes: fx.map stays the identity on video shots.
import { W, H } from "./film-constants.js";

// the affine [a, b, c, d, e, f] (x' = a x + b y + c, y' = d x + e y + f) at dt seconds into the shot, clamped to the clip
export function trackAt(tr, dt) {
  const m = tr.m;
  return m[Math.min(m.length - 1, Math.max(0, Math.round(dt * tr.fps)))];
}

const mul = ([a, b, c, d, e, f], [g, h, i, j, k, l]) => [a * g + b * j, a * h + b * k, a * i + b * l + c, d * g + e * j, d * h + e * k, d * i + e * l + f];
function inv([a, b, c, d, e, f]) {
  const det = a * e - b * d;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

// the plate's motion from shot time `from` to shot time `to` (seconds into the shot)
export const trackBetween = (tr, from, to) => mul(trackAt(tr, to), inv(trackAt(tr, from)));

// fx.map for a tracked shot at edit time t: carries a frame-unit point (x in [-W/H, W/H], y in [-1, 1] up) from
// where it sat on the plate at edit time `at` (default: the shot's first frame) to where that spot is now
export function trackMap(tr, start, t) {
  const s = H / 2;
  return ([x, y], at = start) => {
    const [a, b, c, d, e, f] = trackBetween(tr, at - start, t - start), px = W / 2 + x * s, py = H / 2 - y * s;
    return [(a * px + b * py + c - W / 2) / s, (H / 2 - (d * px + e * py + f)) / s];
  };
}

// pin a full-frame DOM layer (sel, laid out on the plate as it was at edit time `at`) to a tracked shot starting at
// `start`, over edit times [t0, t1): its transform follows the plate frame by frame on every seek
export function pinToTrack(sel, tr, start, { at = start, t0 = start, t1 = Infinity } = {}) {
  const el = document.querySelector(sel);
  el.style.transformOrigin = "0 0";
  const pin = (t) => {
    if (t < t0 - 1e-6 || t >= t1) return;
    const [a, b, c, d, e, f] = trackBetween(tr, at - start, t - start);
    el.style.transform = `matrix(${a},${d},${b},${e},${c},${f})`;
  };
  window.addEventListener("hf-seek", (e) => pin(e && e.detail ? e.detail.time : 0));
  pin(window.__hfThreeTime || 0);
}
