// Camera moves that stack on top of cam() and shake(): handheld drift, panic sway, crash and snap zooms, whip pans,
// dutch tilts and rack focus. Each cue registers a pure function of edit time; on every hf-seek the rig sums them
// into one transform on #fx (videos, GL canvas and pinned props move together, captions and vignette stay put),
// zoomed just enough to keep the frame edges out of view, and hands its depth-aware part (parallax nudge, focus
// plane) to the GL cel plate. Nothing touches the DOM unless a scene uses one of these cues.
import { W, H, FPS, rng, seg, shotAt } from "../core/film-constants.js";

const TAU = Math.PI * 2, PX = H / 1080;   // amplitudes are px of a 1080p frame
const smooth = (k) => k * k * (3 - 2 * k);
// zoom that hides the corners of a frame rolled by `deg`
export const rotCover = (deg) => { const a = (Math.abs(deg) * Math.PI) / 180; return Math.cos(a) + (W / H) * Math.sin(a) - 1; };
// 1 inside [t0, t1], with smooth ramps of `ramp` s at both ends (0: on and off on the frame, for cues spanning shots)
const env = (t, t0, t1, ramp) => (t < t0 || t >= t1 ? 0 : ramp > 0 ? smooth(Math.min(1, (t - t0) / ramp, (t1 - t) / ramp)) : 1);
// smooth noise in [-1, 1]: three incommensurate sines with seeded phases
const wobble = (seed) => {
  const r = rng(seed), p = [r(), r(), r()].map((x) => x * Math.PI);
  return (t, f) => (Math.sin(TAU * f * t + p[0]) + 0.5 * Math.sin(TAU * 2.17 * f * t + p[1]) + 0.25 * Math.sin(TAU * 4.73 * f * t + p[2])) / 1.75;
};

// handheld profiles: the operator's drift (px, degrees, zoom fraction) at `freq` Hz, plus an optional step bob and a
// high-frequency rumble, each [px, Hz]
export const HANDHELD = {
  calm: { x: 5, y: 4, rot: 0.18, zoom: 0.004, freq: 0.3 },
  walk: { x: 9, y: 6, rot: 0.4, zoom: 0.006, freq: 0.55, bob: [6, 1.8] },
  run: { x: 16, y: 10, rot: 0.9, zoom: 0.01, freq: 1.0, bob: [14, 2.6] },
  panic: { x: 22, y: 16, rot: 1.3, zoom: 0.014, freq: 1.6, rumble: [4, 7] },
  quake: { x: 10, y: 8, rot: 0.5, zoom: 0.006, freq: 0.9, rumble: [14, 11] },
};

export function createCameraRig() {
  const cues = [];
  let blurNode = null, needBlur = false, fx = null, shaker = null;
  const add = (f) => { cues.push(f); };

  // handheld over [t0, t1]: continuous drift on x, y, roll and zoom. amp and freq scale the profile; parallax
  // scales how much nearer parts of a depth cel move with it (0: the whole frame moves as one)
  const handheld = (t0, t1, { profile = "calm", amp = 1, freq = 1, seed = 1, ramp = 0.25, parallax = 1 } = {}) => {
    const p = HANDHELD[profile] || HANDHELD.calm, a = PX * amp;
    const [bob, bobF] = p.bob || [0, 0], [rum, rumF] = p.rumble || [0, 0];
    const n = [0, 1, 2, 3, 4, 5].map((i) => wobble(seed * 7 + i * 101));
    const cover = (2 * a * (p.x + bob / 2 + rum)) / W + (2 * a * (p.y + bob + rum)) / H + rotCover(p.rot * amp) + p.zoom * amp;
    add((t) => {
      const e = env(t, t0, t1, ramp);
      if (!e) return null;
      const f = p.freq * freq, step = Math.PI * bobF * freq * t;
      const x = e * a * (p.x * n[0](t, f) + rum * n[4](t, rumF * freq) + (bob / 2) * Math.sin(step));
      const y = e * a * (p.y * n[1](t, f * 0.87) + rum * n[5](t, rumF * freq * 1.13) + bob * Math.sin(2 * step));
      return { x, y, rot: e * amp * p.rot * n[2](t, f * 0.73), scale: 1 + e * amp * p.zoom * n[3](t, f * 0.61), cover: e * cover, nudge: [x * parallax, y * parallax] };
    });
  };

  // panic sway over [t0, t1]: a slow pendulum roll, the frame swinging behind it and bobbing in a figure eight
  const sway = (t0, t1, { amp = 1, freq = 0.35, seed = 7, ramp = 0.4, parallax = 1 } = {}) => {
    const ph = rng(seed)() * Math.PI, n = wobble(seed + 9), a = PX * amp, R = 2.2 * amp, X = 34 * a, Y = 12 * a;
    const cover = rotCover(R * 1.15) + (2 * X) / W + (2 * Y) / H;
    add((t) => {
      const e = env(t, t0, t1, ramp);
      if (!e) return null;
      const w = TAU * freq * t + ph, x = e * X * Math.sin(w - 0.6), y = e * Y * Math.sin(2 * w);
      return { x, y, rot: e * R * (Math.sin(w) + 0.15 * n(t, freq * 3)), cover: e * cover, nudge: [x * parallax, y * parallax] };
    });
  };

  // crash zoom at t: punch in to `to` about a screen point (uv 0..1, y up) over `dur`, hold until `until` (default:
  // the end of the shot at t), ease back over the last `back` s if given; a short blur rides the fast frames
  const crashZoom = (t, { to = 1.35, dur = 4 / FPS, focus = [0.5, 0.5], until = shotAt(t).end, back = 0, blur = 4 } = {}) => {
    const P = [(focus[0] - 0.5) * W, (0.5 - focus[1]) * H];
    if (blur > 0 && dur > 0) needBlur = true;
    add((tt) => {
      if (tt < t || tt >= until) return null;
      const k = dur > 0 ? seg(tt, t, t + dur) : 1, out = back > 0 ? smooth(seg(tt, until - back, until)) : 0;
      const z = 1 + (to - 1) * (1 - Math.pow(1 - k, 4)) * (1 - out), b = k < 1 ? blur * PX * Math.sin(Math.PI * k) : 0;
      return { x: (1 - z) * P[0], y: (1 - z) * P[1], scale: z, blur: [b, b] };
    });
  };
  // snap zoom: the same punch-in on the frame, no travel
  const snapZoom = (t, to = 1.25, o = {}) => crashZoom(t, { ...o, to, dur: 0, blur: 0 });

  // whip pan across a cut at t: the camera swings `dir` (left, right, up, down; the picture streaks the other way),
  // the outgoing shot leaves in the dur/2 before t and the next lands in the dur/2 after, under a directional blur
  // that peaks on the cut. A mirror of the frame (box-reflect) fills the side the travel uncovers.
  // side: "both", "out" (only leave a shot) or "in" (only land on one); dist in frame widths (heights for up/down)
  const whipPan = (t, { dir = "right", dur = 8 / FPS, dist = 0.45, blur = 90, side = "both" } = {}) => {
    const v = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] }[dir] || [-1, 0];   // picture motion, CSS axes
    const D = dist * (v[0] ? W : H), B = blur * PX, h = dur / 2;
    const face = (s) => (v[0] ? (v[0] * s > 0 ? "left" : "right") : v[1] * s > 0 ? "above" : "below");   // side uncovered
    needBlur = true;
    add((tt) => {
      let off, b;
      if (side !== "in" && tt >= t - h && tt < t) { const k = seg(tt, t - h, t); off = D * k * k; b = B * k * k; }
      else if (side !== "out" && tt >= t && tt < t + h) { const k = seg(tt, t, t + h); off = -D * (1 - k) * (1 - k); b = B * (1 - k) * (1 - k); }
      else return null;
      return { x: off * v[0], y: off * v[1], blur: v[0] ? [b, 0] : [0, b], reflect: off ? face(off) : "" };
    });
  };

  // dutch tilt: roll the frame `deg` (+ clockwise) over [t0, t1]; rollIn / rollOut ease it in and out (0: on the cut)
  const dutch = (t0, t1, deg, { rollIn = 0, rollOut = 0 } = {}) => {
    const c = rotCover(deg);
    add((t) => {
      if (t < t0 || t >= t1) return null;
      const e = smooth(Math.min(rollIn > 0 ? seg(t, t0, t0 + rollIn) : 1, rollOut > 0 ? seg(t, t1, t1 - rollOut) : 1));
      return { rot: deg * e, cover: c * e };
    });
  };

  // rack focus over [t0, t1] on a cel shot whose config has `depth`: sharp on depth `from` (0 far .. 1 near) until
  // `at`, racking to `to` over `dur`; aperture: blur px per unit of depth off the focus plane
  const rackFocus = (t0, t1, from, to, { at = t0, dur = 0.6, aperture = 10 } = {}) =>
    add((t) => (t < t0 || t >= t1 ? null : { dof: { plane: from + (to - from) * smooth(dur > 0 ? seg(t, at, at + dur) : t >= at ? 1 : 0), amount: aperture } }));

  // the sum of every cue at t
  const at = (t) => {
    const o = { x: 0, y: 0, rot: 0, scale: 1, cover: 0, bx: 0, by: 0, reflect: "", nx: 0, ny: 0, dof: null };
    for (const f of cues) {
      const c = f(t);
      if (!c) continue;
      o.x += c.x || 0; o.y += c.y || 0; o.rot += c.rot || 0; o.scale *= c.scale || 1; o.cover += c.cover || 0;
      if (c.blur) { o.bx = Math.max(o.bx, c.blur[0]); o.by = Math.max(o.by, c.blur[1]); }
      if (c.reflect) o.reflect = c.reflect;
      if (c.nudge) { o.nx += c.nudge[0]; o.ny += c.nudge[1]; }
      if (c.dof) o.dof = c.dof;
    }
    return o;
  };

  const rig = {
    used: () => cues.length > 0,
    // DOM: one transform on #fx, the rig's blur chained after the #whip blur on #shaker, the whip's mirror on #shaker
    apply(t) {
      if (!fx) {
        fx = document.getElementById("fx");
        shaker = document.getElementById("shaker");
        if (needBlur) {
          blurNode = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
          blurNode.setAttribute("stdDeviation", "0 0");
          blurNode.setAttribute("edgeMode", "duplicate");
          document.getElementById("whipblur").appendChild(blurNode);
        }
      }
      const o = at(t);
      fx.style.transform = `translate(${o.x}px, ${o.y}px) rotate(${o.rot}deg) scale(${o.scale * (1 + o.cover)})`;
      if (blurNode) blurNode.setAttribute("stdDeviation", `${o.bx} ${o.by}`);
      shaker.style.webkitBoxReflect = o.reflect ? `${o.reflect} 0px` : "";
    },
    // GL: camera travel in frame heights for the depth parallax (+x right, +y up) and the focus plane
    gl(t) {
      const o = at(t);
      return { nudge: [-o.nx / H, o.ny / H], dof: o.dof };
    },
  };
  return { rig, handheld, sway, crashZoom, snapZoom, whipPan, dutch, rackFocus };
}
