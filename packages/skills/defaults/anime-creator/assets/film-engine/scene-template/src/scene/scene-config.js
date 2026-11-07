// What the GL layer draws in this scene. Values are measured, not guessed: layer depths and bboxes come from
// the layer decomposition JSON, ground rows and screen positions from contact sheets of the real plates/clips.
// Screen space for FX: centre (0,0), y in [-1, 1] (up), x in [-16/9, 16/9].
import { seg, lerp, easeInOut } from "engine/core/film-constants.js";
import { atDepth } from "engine/gl/particle-weather.js";

export const SCENE = {
  // multiplane sets used by "gl" shots (shot.set picks one; default: the first)
  sets: {
    main: {
      dir: "assets/set", fov: 40, overscan: 1.16, hazeColor: [0.86, 0.9, 0.97],
      // [file, depth (world units from the rest camera), bbox [x1,y1,x2,y2] 0..1000, rest blur (mip bias), overscan?]
      layers: [
        ["L1-base.jpg", 90, [0, 0, 1000, 1000], 0.0, 1.32],
        ["L2-mid.png", 30, [0, 300, 1000, 1000], 0.0],
        ["L3-fg.png", 6, [0, 650, 1000, 1000], 1.2],
      ],
    },
  },
  // figures standing on a set (feet on the ground row at their depth); keep empty when acting comes from video
  cards: { main: [] },
  // one weather system for the scene; perShot entries switch it on (a shot without an entry has none)
  weather: {
    preset: "petal", count: 3200,
    defaults: { swirl: 0.45 },
    perShot: {
      s01: { density: 0.33, size: 0.17, swirl: 0.5, wind: [0.5, -0.35, 4.2] },     // flying forward
      s02: { density: 0.21, size: 0.14, wind: [2.4, -0.35, 0.4] },
      s03: { density: 0.14, size: 0.15, wind: [1.4, -0.45, 0.0], burst: { at: 4.2, c: atDepth([0.1, 0.0], 8), amt: 0.3, r: 5 } },
    },
  },
  // still cels: push-in from zoom[0] to zoom[1] about a focus uv (0..1, y up)
  cels: { s03: { zoom: [1.0, 1.07], focus: [0.6, 0.55] } },
  // camera paths for gl shots, a pure function of edit time
  cameras: {
    s01: (t, shot) => {
      const k = easeInOut(seg(t, shot.start, shot.end));
      return { z: lerp(0.6, -5.4, k), y: lerp(-0.35, 0.55, k), roll: lerp(-2.2, 1.0, k), tilt: lerp(-1.5, 2.5, k), focus: lerp(9, 22, k) };
    },
  },
  // spark systems: [count, seed]
  sparks: [[240, 3], [200, 11]],
};
