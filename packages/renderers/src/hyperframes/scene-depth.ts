import type { MotifAnchor, Scene, SceneCamera, SceneMotif } from "@studix/video-ir";
import { cssColor } from "./brand-tokens.ts";
import { cssRule, num, seconds } from "./html-utils.ts";
import type { TimelineWriter } from "./scene-timeline.ts";

/**
 * Depth grammar of a scene: background texture layers, foreground accents, the camera move that drifts the
 * three planes (back, content, front) at different rates, and the motif that carries across cuts. Every
 * layer is CSS (no assets, no randomness) and every move is one seek-safe GSAP tween, so a frame renders
 * the same at any seek position.
 */

type Frame = { width: number; height: number };

const short = (f: Frame) => Math.min(f.width, f.height);

/** A fixed-seed noise tile: the same grain on every frame and every render. */
const GRAIN_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 1.4 -0.2"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
  );

const mix = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** Markup and CSS of the scene's background layers, drawn back to front inside the back plane. */
export function backgroundLayers(scene: Scene, stage: string, frame: Frame): { html: string; css: string[] } {
  const layers = scene.depth?.background ?? [];
  const s = short(frame);
  const css: string[] = [];
  const html = layers.map((layer) => {
    const sel = `#${stage} .bg-${layer}`;
    switch (layer) {
      case "grid": {
        const cell = Math.round(0.08 * s);
        const line = mix("var(--c-foreground)", 7);
        css.push(
          cssRule(sel, [
            "position: absolute;",
            "inset: -10%;",
            `background-image: linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px);`,
            `background-size: ${cell}px ${cell}px;`,
          ]),
        );
        break;
      }
      case "glow":
        css.push(
          cssRule(sel, [
            "position: absolute;",
            "inset: -10%;",
            `background: radial-gradient(circle at 72% 28%, ${mix("var(--c-accent)", 22)} 0%, transparent 45%), radial-gradient(circle at 22% 82%, ${mix("var(--c-primary)", 12)} 0%, transparent 40%);`,
          ]),
        );
        break;
      case "grain":
        css.push(
          cssRule(sel, [
            "position: absolute;",
            "inset: 0;",
            `background-image: url("${GRAIN_SVG}");`,
            "background-size: 240px 240px;",
            "opacity: 0.12;",
          ]),
        );
        break;
      case "vignette":
        css.push(
          cssRule(sel, [
            "position: absolute;",
            "inset: 0;",
            "background: radial-gradient(ellipse at 50% 50%, transparent 60%, rgba(0, 0, 0, 0.24) 100%);",
          ]),
        );
        break;
    }
    return `<div class="bg-${layer}"></div>`;
  });
  return { html: html.join(""), css };
}

/** Markup and CSS of the foreground accents; `rule` draws itself in at the start of the scene. */
export function foregroundAccents(
  scene: Scene,
  stage: string,
  frame: Frame,
  w: TimelineWriter,
): { html: string; css: string[] } {
  const accents = scene.depth?.foreground ?? [];
  const s = short(frame);
  const inset = Math.round(ACCENT_INSET * s);
  const stroke = Math.max(2, Math.round(0.004 * s));
  const css: string[] = [];
  const html = accents.map((accent) => {
    const sel = `#${stage} .fg-${accent}`;
    switch (accent) {
      case "corners": {
        const arm = Math.round(0.06 * s);
        const corner = (v: "top" | "bottom", h: "left" | "right") =>
          cssRule(`${sel} .c-${v}-${h}`, [
            `${v}: ${inset}px;`,
            `${h}: ${inset}px;`,
            `border-${v}: ${stroke}px solid var(--c-accent);`,
            `border-${h}: ${stroke}px solid var(--c-accent);`,
          ]);
        css.push(
          cssRule(`${sel} > div`, ["position: absolute;", `width: ${arm}px;`, `height: ${arm}px;`]),
          corner("top", "left"),
          corner("top", "right"),
          corner("bottom", "left"),
          corner("bottom", "right"),
        );
        return `<div class="fg-corners"><div class="c-top-left"></div><div class="c-top-right"></div><div class="c-bottom-left"></div><div class="c-bottom-right"></div></div>`;
      }
      case "rule":
        css.push(
          cssRule(sel, [
            "position: absolute;",
            // Along the top edge inside the frame margin, clear of the content's safe area and starting past
            // the top-left corner bracket, so the two never merge into one bar.
            `left: ${inset + Math.round(0.06 * s) + 2 * stroke}px;`,
            `top: ${inset}px;`,
            `width: ${Math.round(0.14 * s)}px;`,
            `height: ${Math.max(4, Math.round(0.009 * s))}px;`,
            "background: var(--c-accent);",
            "transform-origin: 0% 50%;",
          ]),
        );
        w.fromTo(
          sel,
          { scaleX: 0 },
          {
            scaleX: 1,
            duration: seconds(Math.min(600, Math.floor(scene.durationMs / 3))),
            ease: "power3.out",
          },
          0,
        );
        return `<div class="fg-rule"></div>`;
      case "dots": {
        const gap = Math.round(0.022 * s);
        const dot = Math.max(3, Math.round(0.006 * s));
        css.push(
          cssRule(sel, [
            "position: absolute;",
            // On the right edge, half way down: the corners stay free for the motif.
            `right: ${Math.round(inset / 2)}px;`,
            `top: calc(50% - ${Math.round(gap * 2)}px);`,
            `width: ${gap * 2}px;`,
            `height: ${gap * 4}px;`,
            `background-image: radial-gradient(circle, ${mix("var(--c-foreground)", 45)} ${dot / 2}px, transparent ${dot / 2 + 1}px);`,
            `background-size: ${gap}px ${gap}px;`,
          ]),
        );
        return `<div class="fg-dots"></div>`;
      }
    }
    return "";
  });
  return { html: html.join(""), css };
}

/** Inset of the foreground accents from the frame edge, as a fraction of the short edge. */
const ACCENT_INSET = 0.035;
/** Safe inset of the content (see `compileScene`), as a fraction of the short edge. */
const CONTENT_SAFE = 0.07;

/**
 * Per-plane camera travel: [back, content, front]. Content moves as the move is named. Travel is bounded so
 * nothing leaves the frame at any intensity: content moves at most half its safe inset (a zoom scales its
 * farthest edge by no more than that), and the front accents, which hug the edges, never scale and drift
 * at most 40% of their inset. The back plane is held larger than the frame, so it has room to move.
 */
export function planeMoves(
  camera: SceneCamera | undefined,
  frame: Frame,
): Array<{ from: Vars; to: Vars } | undefined> | undefined {
  if (!camera || camera.move === "static") return undefined;
  const k = camera.intensity ?? 1;
  const s = short(frame);
  const safe = CONTENT_SAFE * s;
  const maxShift = safe / 2;
  // The content's farthest edge sits (long edge / 2 - safe) from the centre, and a zoom moves it by that x (scale - 1).
  const maxZoom = maxShift / (Math.max(frame.width, frame.height) / 2 - safe);
  const frontShift = Math.round(0.4 * ACCENT_INSET * s);
  const scaleBy = (amount: number) => Number(num(1 + amount));
  const zoom = (inward: boolean) => {
    const [back, content] = [scaleBy(Math.min(0.06, 0.03 * k)), scaleBy(Math.min(maxZoom, 0.04 * k))].map(
      (big) =>
        inward ? { from: { scale: 1 }, to: { scale: big } } : { from: { scale: big }, to: { scale: 1 } },
    );
    return [back, content, undefined];
  };
  const drift = (sign: 1 | -1, rates: [number, number, number]) => {
    const base = 0.02 * frame.width * k;
    const d = [
      Math.round(Math.min(base * rates[0], 0.025 * frame.width)),
      Math.round(Math.min(base * rates[1], maxShift)),
      Math.round(Math.min(base * rates[2], frontShift)),
    ].map((v) => v * sign);
    return d.map((v, i) => {
      const hold: Vars = i === 0 ? { scale: 1.06 } : {};
      return { from: { x: -v, ...hold }, to: { x: v, ...hold } };
    });
  };
  switch (camera.move) {
    case "push-in":
      return zoom(true);
    case "pull-back":
      return zoom(false);
    case "pan-left":
      return drift(-1, [0.6, 1, 1.4]);
    case "pan-right":
      return drift(1, [0.6, 1, 1.4]);
    case "parallax":
      return drift(-1, [0.25, 0.75, 1.6]);
  }
}

type Vars = Record<string, string | number | boolean>;

/** The scene's camera move: one linear-in-feel tween per plane over the whole scene. */
export function writeCamera(w: TimelineWriter, stage: string, scene: Scene, frame: Frame): void {
  const moves = planeMoves(scene.camera, frame);
  if (!moves) return;
  const planes = ["back", "mid", "front"];
  moves.forEach((m, i) => {
    // The front plane exists only when the scene draws foreground accents, and holds still on a zoom.
    if (!m || (i === 2 && (scene.depth?.foreground ?? []).length === 0)) return;
    w.fromTo(
      `#${stage} .plane-${planes[i]}`,
      m.from,
      { ...m.to, duration: seconds(scene.durationMs), ease: "sine.inOut" },
      0,
    );
  });
}

const MOTIF_SIZE = { small: 0.06, medium: 0.1, large: 0.18 } as const;

/** Row and column of each motif anchor: 0 is the top/left edge, 1 the middle, 2 the bottom/right edge. */
const ANCHOR_CELL: Record<MotifAnchor, [row: number, col: number]> = {
  "top-left": [0, 0],
  top: [0, 1],
  "top-right": [0, 2],
  left: [1, 0],
  center: [1, 1],
  right: [1, 2],
  "bottom-left": [2, 0],
  bottom: [2, 1],
  "bottom-right": [2, 2],
};

/** Centre of a motif anchor in frame pixels, inset from the edges by `margin`. */
function anchorPoint(anchor: MotifAnchor, frame: Frame, margin: number): { x: number; y: number } {
  const [row, col] = ANCHOR_CELL[anchor];
  const at = (cell: number, edge: number) => (cell === 0 ? margin : cell === 1 ? edge / 2 : edge - margin);
  return { x: Math.round(at(col, frame.width)), y: Math.round(at(row, frame.height)) };
}

function motifBox(motif: SceneMotif, frame: Frame): { w: number; h: number; x: number; y: number } {
  const s = short(frame);
  const size = Math.round(MOTIF_SIZE[motif.size ?? "medium"] * s);
  const [w, h] = motif.shape === "bar" ? [size * 2.4, Math.round(size * 0.28)] : [size, size];
  // Inside the corner accents (which reach 0.095 of the short edge) and the rule, never on top of them.
  const margin = Math.round(0.11 * s + Math.max(w, h) / 2);
  const p = anchorPoint(motif.anchor, frame, margin);
  return { w: Math.round(w), h: Math.round(h), x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2) };
}

/**
 * The scene's motif: drawn behind the content and unmoved by the camera. When the previous scene ends on a
 * motif of the same shape, this one starts exactly where that one sat and travels to its own anchor, so the
 * shape reads as one object across the cut; otherwise it pops in. It leaves at the end when the next scene
 * carries no motif of its shape.
 */
export function motifLayer(
  w: TimelineWriter,
  stage: string,
  scene: Scene,
  neighbours: { prev?: SceneMotif; next?: SceneMotif },
  frame: Frame,
): { html: string; css: string[] } {
  const motif = scene.motif;
  if (!motif) return { html: "", css: [] };
  const box = motifBox(motif, frame);
  const { prev, next } = neighbours;
  const color = cssColor(motif.color ?? "accent");
  const ring = Math.max(3, Math.round(box.w * 0.12));
  const sel = `#${stage} .motif`;
  const css = [
    cssRule(sel, [
      "position: absolute;",
      `left: ${box.x}px;`,
      `top: ${box.y}px;`,
      `width: ${box.w}px;`,
      `height: ${box.h}px;`,
      motif.shape === "ring" ? `border: ${ring}px solid ${color};` : `background: ${color};`,
      "box-sizing: border-box;",
      `border-radius: ${motif.shape === "circle" || motif.shape === "ring" ? "50%" : motif.shape === "bar" ? `${Math.round(box.h / 2)}px` : `${Math.round(box.w * 0.12)}px`};`,
    ]),
  ];
  const travelMs = Math.min(700, Math.floor(scene.durationMs * 0.35));
  if (prev && prev.shape === motif.shape) {
    const from = motifBox(prev, frame);
    const scale = Number(num(from.w / box.w));
    w.fromTo(
      sel,
      { x: from.x + from.w / 2 - (box.x + box.w / 2), y: from.y + from.h / 2 - (box.y + box.h / 2), scale },
      { x: 0, y: 0, scale: 1, duration: seconds(travelMs), ease: "power3.inOut" },
      0,
    );
  } else {
    w.fromTo(
      sel,
      { scale: 0 },
      { scale: 1, duration: seconds(Math.min(450, travelMs)), ease: "back.out(1.7)" },
      0,
    );
  }
  if (!next || next.shape !== motif.shape) {
    const outMs = Math.min(300, Math.floor(scene.durationMs * 0.2));
    w.fromTo(
      sel,
      { scale: 1 },
      { scale: 0, duration: seconds(outMs), ease: "power2.in" },
      seconds(scene.durationMs - outMs),
    );
  }
  return { html: `<div class="motif"></div>`, css };
}
