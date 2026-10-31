// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/assets/film-engine/engine/src/core/film-constants.js (Studix changes are marked "Studix:").
// Frame size, frame rate and the edit decision list shared by the GL engine and the DOM edit.
// "edl" is an esbuild alias for the scene's own edl.json (see engine/build-scene.sh), so one engine
// copy serves every scene of a series.
import EDL from "edl";

export { EDL };
export const W = EDL.width || 1920, H = EDL.height || 1080, FPS = EDL.fps, DURATION = EDL.duration;
export const SHOTS = EDL.shots;
export const ASPECT = W / H;

export const shotAt = (t) => SHOTS.find((s) => t >= s.start && t < s.end) || SHOTS[SHOTS.length - 1];
export const shotById = Object.fromEntries(SHOTS.map((s) => [s.id, s]));
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const seg = (t, a, b) => clamp01((t - a) / (b - a));
export const lerp = (a, b, k) => a + (b - a) * k;
export const lerp2 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k)];
export const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
export const easeOut = (k) => 1 - Math.pow(1 - k, 3);
export const easeIn = (k) => k * k * k;
// a short envelope: instant attack at a, exponential decay of `tau` seconds (0 before a)
export const pulse = (t, a, tau) => (t < a ? 0 : Math.exp(-(t - a) / tau));
// 0 -> 1 -> 0 over [a, b]
export const bell = (t, a, b) => Math.sin(Math.PI * seg(t, a, b));
// quadratic bezier through control c
export const bez = (a, c, b, k) => lerp2(lerp2(a, c, k), lerp2(c, b, k), k);
// deterministic pseudo-random sequence in [-1, 1]: every render and every seek gives the same value
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
}
