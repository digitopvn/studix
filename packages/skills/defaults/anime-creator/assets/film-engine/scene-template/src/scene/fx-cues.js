// Per-shot light FX in edit time: glints, streaks, qi arcs, flashes, spark sprays. Positions are measured on the
// conformed clips and cels (contact sheet with a grid), never eyeballed. On cel shots use fx.map(point) so the
// FX follow the cel's push-in.
import { seg, bell, pulse, lerp2, easeInOut } from "engine/core/film-constants.js";

const WHITE = [1, 0.95, 0.92], GOLD = [1.0, 0.78, 0.5], PINK = [1.0, 0.45, 0.68], BLUE = [0.42, 0.72, 1.0];

// a clash hit: flash + star glint + spark spray at a contact point (the most reused cue in a fight)
export function hit(t, a, p, { glow, sparks }, { big = 1, glintSlot = 0, spray = 0, tint = GOLD } = {}) {
  glow.flash(p, 0.9 * big * pulse(t, a, 0.08));
  glow.glint(glintSlot, p, 0.3 * big, 0.2, WHITE, 1.5 * pulse(t, a, 0.14));
  sparks[spray].fire(t - a, p, { speed: 1.9 * big, life: 0.55, gravity: 1.3, drag: 3.2, size: 0.0042, tint, intensity: 1.3 });
}

export function fxCues(t, shot, fx) {
  const { glow, map } = fx;
  switch (shot.id) {
    case "s01": hit(t, 1.42, [0.42, 0.3], fx, { big: 0.6, tint: PINK }); return;
    case "s02": glow.glint(0, [-1.5, 0.66], 0.15, 0.3, WHITE, 1.1 * bell(t, 1.9, 2.3)); return;
    case "s03": {
      // a glint runs up the blade, hilt to tip, as it rises
      const k = easeInOut(seg(t, 3.56, 3.88));
      glow.glint(0, map(lerp2([0.21, -0.97], [1.78, -0.06], k)), 0.2, 0.52, WHITE, 1.3 * bell(t, 3.54, 3.92));
      glow.arc(0, [0, 0.05], 0.95, 0.05, 2.6, 4.2, 1.6 * seg(t, 3.9, 4.3), BLUE, 1.2 * bell(t, 3.85, 4.4));
      return;
    }
    default: return;
  }
}
