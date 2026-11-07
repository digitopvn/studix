// One frame of the GL layer at edit time t. The canvas sits over the edit's <video> elements:
//  - gl shots draw an opaque multiplane set posed by the scene's camera path for that shot;
//  - cel shots draw their still with a push-in (zoom about a focus point), or a 2.5D depth move when their
//    config has `depth` (dolly, truck, orbit, plus the edit rig's parallax nudge and rack focus);
//  - video shots leave the canvas transparent, so only weather and light FX land on the footage; a shot with a
//    plate track (SCENE.tracks) hands fxCues a map that carries FX positions along the clip's own motion.
// Everything is a pure function of t: no state carries between frames, so seeks and out-of-order
// render workers produce identical pixels.
import { SHOTS, shotAt, seg, lerp } from "./film-constants.js";
import { depthPose } from "../gl/cel-plate.js";
import { trackMap } from "./plate-track.js";

const WEATHER_DEFAULT = { swirl: 0.4, vortex: 0, vortexC: [0, 0, -10], burstT: 1e9, burstAmt: 0, burstR: 6, burstC: [0, 0, -10], opacity: 1 };
const CEL_DEFAULT = { zoom: [1.0, 1.04], focus: [0.5, 0.5] };

// the 2.5D pose of a cel at progress k, null without `depth` (the flat push); rig: the edit rig's GL part at t
const depthOf = (w, c, id, k, rig) => (c.depth ? { ...depthPose(c.depth, k, c.zoom, c.focus, rig || {}), map: w.tex.depth[id] } : null);

// weather for a shot; burst times in the scene config are EDIT times
export function weatherParams(t, shot, idx, cfg) {
  const p = { ...WEATHER_DEFAULT, ...(cfg.defaults || {}), ...((cfg.perShot || {})[shot.id] || { density: 0 }) };
  const settle = cfg.settle ?? 2.5;            // start each shot with a settled field, not an empty box
  if (p.burst) { p.burstT = p.burst.at - shot.start + settle; p.burstC = p.burst.c; p.burstAmt = p.burst.amt; p.burstR = p.burst.r ?? 6; }
  delete p.burst;
  const preset = p.preset; delete p.preset;
  return { params: { ...p, time: t - shot.start + settle, field: idx * 0.618 }, preset };
}

export function drawFrame(w, t, scene, fxCues) {
  const { renderer, sets, cel, weather, glow, sparks, tex } = w;
  const shot = shotAt(t), idx = SHOTS.indexOf(shot);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  let map = (p) => p;
  if (shot.kind === "gl") {
    const set = sets[shot.set] || Object.values(sets)[0];
    const path = (scene.cameras || {})[shot.id];
    set.pose(path ? path(t, shot) : {});
    set.render(renderer);
  } else if (shot.kind === "cel") {
    const c = { ...CEL_DEFAULT, ...((scene.cels || {})[shot.id] || {}) }, k = seg(t, shot.start, shot.end);
    map = cel.show(tex.cels[shot.id], lerp(c.zoom[0], c.zoom[1], k), c.focus, 1, depthOf(w, c, shot.id, k, w.rig && w.rig.gl(t)));
    cel.render(renderer);
  } else if (scene.tracks && scene.tracks[shot.id]) {
    map = trackMap(scene.tracks[shot.id], shot.start, t);
  }
  // `xfade` on a shot cross-dissolves out of the previous cel shot: that cel, still pushing, fades out on top of this
  // shot (a cel, a set, or the footage under a transparent canvas)
  const prev = SHOTS[idx - 1];
  if (shot.xfade && prev && prev.kind === "cel" && t < shot.start + shot.xfade) {
    const c = { ...CEL_DEFAULT, ...((scene.cels || {})[prev.id] || {}) }, k = seg(t, shot.start, shot.start + shot.xfade);
    const a = 1 - k * k * (3 - 2 * k);
    // the outgoing cel keeps its push running under the dissolve: holding its last pose reads as a freeze against
    // the incoming shot's move
    const kp = (t - prev.start) / (prev.end - prev.start);
    if (shot.kind !== "cel") renderer.clearDepth();
    cel.show(tex.cels[prev.id], lerp(c.zoom[0], c.zoom[1], kp), c.focus, a, depthOf(w, c, prev.id, Math.min(kp, 1)));
    cel.render(renderer);
  }
  if (weather) {
    const { params, preset } = weatherParams(t, shot, idx, scene.weather);
    const want = preset || scene.weather.preset;
    if (want && want !== w.weatherPreset) { weather.preset(want); w.weatherPreset = want; }
    weather.set(params);
    weather.render(renderer);
  }
  glow.clear();
  for (const s of sparks) s.fire(-1, [0, 0]);
  if (fxCues) fxCues(t, shot, { glow, sparks, sparksA: sparks[0], sparksB: sparks[1], map, world: w });
  glow.render(renderer);
  for (const s of sparks) s.render(renderer);
}
