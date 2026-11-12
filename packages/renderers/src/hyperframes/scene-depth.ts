import type { CameraMove, Scene } from "@studix/video-ir";
import { cssColor, tint } from "./brand-tokens.ts";
import { cssRule, num, seconds } from "./html-utils.ts";
import type { TimelineWriter } from "./scene-timeline.ts";

/**
 * Camera and depth grammar of a scene: decorative planes behind and in front of the shots, a camera move
 * that shifts each plane by its depth, and a motif shape handed over from scene to scene. Everything is drawn
 * in palette roles and moved by the scene's seek-safe GSAP timeline (absolute positions, transforms and
 * opacity only), so every frame is deterministic.
 *
 * Plane order, back to front: `back` (grid, glow), the underlay (background media, full-bleed shots), the
 * motif, the content regions, `front` (corners, bokeh), then the `lens` (grain, vignette), which sits over
 * the picture and never moves, like the glass it stands for. Captions stay above all of it and never move.
 */

export type Plane = "back" | "underlay" | "content" | "front";

/** How far each plane moves relative to the shots; parallax spreads the planes further apart. */
const DEPTH: Record<"normal" | "parallax", Record<Plane, number>> = {
  normal: { back: 0.5, underlay: 0.75, content: 1, front: 1.4 },
  parallax: { back: 0.2, underlay: 0.5, content: 1, front: 2.4 },
};

/** Scale gained over a push or a pull at depth 1, and the pan travel as a fraction of the frame width. */
const PUSH = 0.06;
const PAN = 0.025;

/** Element ids of the camera-moved planes of a scene. */
export const planeId = (prefix: string, plane: Plane) => `${prefix}plane-${plane}`;

type Vars = Record<string, number | string>;

function cameraKeys(move: CameraMove, depth: number, width: number): [Vars, Vars] | undefined {
  const pan = Math.round(PAN * width * depth);
  switch (move) {
    case "push-in":
      return [{ scale: 1 }, { scale: Number(num(1 + PUSH * depth)) }];
    case "pull-back":
      return [{ scale: Number(num(1 + PUSH * depth)) }, { scale: 1 }];
    case "pan-left":
      return [{ x: pan }, { x: -pan }];
    case "pan-right":
      return [{ x: -pan }, { x: pan }];
    case "parallax":
      // A sideways drift with a slight push, so the planes slide past each other at their own speeds.
      return [
        { x: pan, scale: 1 },
        { x: -pan, scale: Number(num(1 + (PUSH / 3) * depth)) },
      ];
    case "static":
      return undefined;
  }
}

/** The camera move over the whole scene: every plane from its start to its end pose, eased in and out. */
export function writeCamera(
  w: TimelineWriter,
  prefix: string,
  scene: Scene,
  frame: { width: number; height: number },
  planes: ReadonlySet<Plane>,
): void {
  const move = scene.camera ?? "static";
  const depth = DEPTH[move === "parallax" ? "parallax" : "normal"];
  const d = seconds(scene.durationMs);
  for (const plane of ["back", "underlay", "content", "front"] as const) {
    if (!planes.has(plane)) continue;
    const keys = cameraKeys(move, depth[plane], frame.width);
    if (!keys) continue;
    w.fromTo(`#${planeId(prefix, plane)}`, keys[0], { ...keys[1], duration: d, ease: "sine.inOut" }, 0);
  }
}

/** A deterministic 0..1 sequence from a seed (mulberry32), so decorative placement never varies. */
function random(seed: string): () => number {
  let a = 0;
  for (const ch of seed) a = (Math.imul(a ^ ch.charCodeAt(0), 2654435761) + 1) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Static film grain: a seeded SVG turbulence tile. */
const GRAIN_TILE = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.9 0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
)}")`;

/**
 * Where the motif rests at each cut, as fractions of the frame (centre x, centre y): the four corners in
 * clockwise order, so each scene carries it along one edge of the frame and never across the headline in the
 * middle. Scene `i` moves from pose `i` to pose `i + 1` and turns a quarter, from diagonal at one corner to
 * diagonal at the next, so a bar lies along the edge it travels; the next scene picks the motif up exactly
 * where, and as turned as, this one left it.
 */
const MOTIF_POSES: ReadonlyArray<readonly [number, number]> = [
  [0.9, 0.1],
  [0.9, 0.8],
  [0.1, 0.8],
  [0.1, 0.1],
];

export interface DepthMarkup {
  /** Planes behind the underlay, behind the content (the motif) and in front of it, and the fixed lens. */
  back: string;
  motif: string;
  front: string;
  lens: string;
  css: string[];
}

/**
 * Markup, styles and motion of a scene's depth planes and motif. `sceneIndex` is the scene's place in the
 * video, which fixes the motif's poses at both of its cuts.
 */
export function compileDepth(
  w: TimelineWriter,
  input: {
    scene: Scene;
    sceneIndex: number;
    prefix: string;
    stageId: string;
    frame: { width: number; height: number };
  },
): DepthMarkup {
  const { scene, prefix, stageId, frame } = input;
  const short = Math.min(frame.width, frame.height);
  const background = new Set(scene.depth?.background ?? []);
  const foreground = new Set(scene.depth?.foreground ?? []);
  const css: string[] = [];
  // Moving planes overhang the frame so a pan or a pull never shows their edge.
  const bleed = Math.round(0.08 * Math.max(frame.width, frame.height));
  const back: string[] = [];
  if (background.has("glow")) {
    back.push('<div class="glow"></div>');
    css.push(
      cssRule(`#${stageId} .glow`, [
        `background: radial-gradient(circle at 72% 28%, ${tint("accent", 34)} 0%, transparent 46%), radial-gradient(circle at 22% 80%, ${tint("primary", 22)} 0%, transparent 42%);`,
      ]),
    );
  }
  if (background.has("grid")) {
    const cell = Math.round(0.08 * short);
    back.push('<div class="grid"></div>');
    css.push(
      cssRule(`#${stageId} .grid`, [
        `background-image: linear-gradient(${tint("foreground", 9)} 1px, transparent 1px), linear-gradient(90deg, ${tint("foreground", 9)} 1px, transparent 1px);`,
        `background-size: ${cell}px ${cell}px;`,
        `background-position: center center;`,
      ]),
    );
  }

  const front: string[] = [];
  if (foreground.has("corners")) {
    const arm = Math.round(0.06 * short);
    const line = Math.max(2, Math.round(0.004 * short));
    // Inside the overhang: the brackets sit just inside the visible frame's safe edge.
    const inset = bleed + Math.round(0.035 * short);
    const sides = [
      ["top", "left"],
      ["top", "right"],
      ["bottom", "left"],
      ["bottom", "right"],
    ] as const;
    front.push(
      `<div class="corners">${sides.map(([v, h]) => `<i class="corner ${v} ${h}"></i>`).join("")}</div>`,
    );
    css.push(
      cssRule(`#${stageId} .corner`, [
        "position: absolute;",
        `width: ${arm}px;`,
        `height: ${arm}px;`,
        `border: 0 solid ${tint("accent", 80)};`,
      ]),
      ...sides.map(([v, h]) =>
        cssRule(`#${stageId} .corner.${v}.${h}`, [
          `${v}: ${inset}px;`,
          `${h}: ${inset}px;`,
          `border-${v}-width: ${line}px;`,
          `border-${h}-width: ${line}px;`,
        ]),
      ),
    );
  }
  if (foreground.has("bokeh")) {
    const next = random(`${scene.id}:bokeh`);
    const dots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const size = Math.round((0.06 + 0.08 * next()) * short);
      // Bokeh keeps to the outer band of the visible frame (the plane overhangs it by about 7% a side), so it
      // never sits on the headline.
      const band = () => (next() < 0.5 ? 10 + 7 * next() : 83 + 7 * next());
      const edge = i % 2 === 0;
      const x = edge ? band() : 15 + 70 * next();
      const y = edge ? 15 + 70 * next() : band();
      const role = i % 2 === 0 ? "accent" : "foreground";
      dots.push(
        `<i style="position:absolute;left:calc(${num(x)}% - ${size / 2}px);top:calc(${num(y)}% - ${size / 2}px);width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle, ${tint(role, 26)} 0%, transparent 70%);"></i>`,
      );
    }
    front.push(`<div class="bokeh">${dots.join("")}</div>`);
  }

  const lens: string[] = [];
  if (background.has("vignette")) {
    lens.push('<div class="vignette"></div>');
    css.push(
      cssRule(`#${stageId} .vignette`, [
        "background: radial-gradient(ellipse at center, transparent 58%, rgba(0, 0, 0, 0.32) 100%);",
      ]),
    );
  }
  if (background.has("grain")) {
    lens.push('<div class="grain"></div>');
    css.push(
      cssRule(`#${stageId} .grain`, [
        `background-image: ${GRAIN_TILE};`,
        "background-size: 240px 240px;",
        "opacity: 0.07;",
        "mix-blend-mode: overlay;",
      ]),
    );
  }

  let motif = "";
  if (scene.motif) {
    const id = `${prefix}motif`;
    const size = Math.round((scene.motif.shape === "bar" ? 0.16 : 0.09) * short);
    const height = scene.motif.shape === "bar" ? Math.round(size / 6) : size;
    const colour = cssColor(scene.motif.color ?? "accent");
    const fill =
      scene.motif.shape === "ring"
        ? [`border: ${Math.max(3, Math.round(size / 9))}px solid ${colour};`, "border-radius: 50%;"]
        : [
            `background: ${colour};`,
            ...(scene.motif.shape === "circle" ? ["border-radius: 50%;"] : []),
            ...(scene.motif.shape === "bar" ? [`border-radius: ${Math.round(height / 2)}px;`] : []),
          ];
    css.push(
      cssRule(`#${id}`, [
        "position: absolute;",
        "left: 0;",
        "top: 0;",
        `width: ${size}px;`,
        `height: ${height}px;`,
        "box-sizing: border-box;",
        ...fill,
      ]),
    );
    const pose = (k: number): Vars => {
      const [cx, cy] = MOTIF_POSES[k % MOTIF_POSES.length]!;
      return {
        x: Math.round(cx * frame.width - size / 2),
        y: Math.round(cy * frame.height - height / 2),
        rotation: 45 + 90 * k,
      };
    };
    const from = pose(input.sceneIndex);
    const to = pose(input.sceneIndex + 1);
    w.fromTo(`#${id}`, from, { ...to, duration: seconds(scene.durationMs), ease: "sine.inOut" }, 0);
    motif = `<div id="${id}" class="motif"></div>`;
  }

  if (back.length || front.length || lens.length) {
    css.unshift(
      cssRule(`#${stageId} .plane`, ["position: absolute;", `inset: -${bleed}px;`, "pointer-events: none;"]),
      cssRule(`#${stageId} .plane > *, #${stageId} .lens > *`, ["position: absolute;", "inset: 0;"]),
      cssRule(`#${stageId} .lens`, ["position: absolute;", "inset: 0;", "pointer-events: none;"]),
    );
  }
  return {
    back: back.length ? `<div id="${planeId(prefix, "back")}" class="plane">${back.join("")}</div>` : "",
    motif,
    front: front.length ? `<div id="${planeId(prefix, "front")}" class="plane">${front.join("")}</div>` : "",
    lens: lens.length ? `<div class="lens">${lens.join("")}</div>` : "",
    css,
  };
}
