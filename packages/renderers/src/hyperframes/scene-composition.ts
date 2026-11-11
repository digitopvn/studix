// Adapted from motion-mcp packages/hyperframes-adapter/src/compile.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import type { ColorRole, Scene, Shot } from "@studix/video-ir";
import { COLOR_ROLES, cssColor, TEXT_STYLES } from "./brand-tokens.ts";
import { cssRule, escapeHtml, indent, num, scriptJson, seconds } from "./html-utils.ts";
import { writeLayoutMotion } from "./layout-markup.ts";
import {
  type ResolvedTransition,
  TimelineWriter,
  writeShotMotion,
  writeTransition,
} from "./scene-timeline.ts";
import { renderShotMarkup, type ShotMarkupContext, shotDomId, videoClipTag } from "./shot-markup.ts";

/** A burned-in caption cue in scene-local milliseconds. */
export interface SceneCaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SceneCompileInput {
  scene: Scene;
  palette: Record<ColorRole, string>;
  transitions: { in?: ResolvedTransition; out?: ResolvedTransition };
  captions: { position: "top" | "middle" | "bottom"; cues: SceneCaptionCue[] };
  markup: Omit<ShotMarkupContext, "prefix"> & {
    /** Asset ids copied as video files; a background with one of these plays as a clip. */
    videoAssetIds: ReadonlySet<string>;
  };
}

export interface CompiledScene {
  /** Project-relative composition path. */
  path: string;
  /** Final file content once the shared @font-face CSS is known. */
  body: (fontCss: string) => string;
}

const REGIONS = ["top", "middle", "bottom"] as const;
const JUSTIFY = { start: "start", center: "center", end: "end" } as const;

/**
 * Shots of one region that overlap in time are placed in separate lanes (stacked vertically); shots that
 * follow each other share a lane and occupy the same spot. Assignment is first-fit in authored order, so
 * the layout is deterministic.
 */
export function assignLanes(shots: readonly Shot[]): Shot[][] {
  const lanes: Shot[][] = [];
  for (const shot of shots) {
    const end = shot.startMs + shot.durationMs;
    const lane = lanes.find((l) =>
      l.every((o) => end <= o.startMs || shot.startMs >= o.startMs + o.durationMs),
    );
    if (lane) lane.push(shot);
    else lanes.push([shot]);
  }
  return lanes;
}

export function compileScene(input: SceneCompileInput): CompiledScene {
  const { scene, palette, markup } = input;
  const prefix = `s-${scene.id}__`;
  const ctx: ShotMarkupContext = { ...markup, prefix, palette };
  const { width, height } = markup.frame;
  const stageId = `${prefix}stage`;
  const safe = Math.round(0.07 * Math.min(width, height));
  const gap = Math.round(0.03 * Math.min(width, height));

  const css: string[] = [
    cssRule(`#${stageId}`, [
      ...COLOR_ROLES.map((role) => `--c-${role}: ${palette[role]};`),
      "position: absolute;",
      "left: 0;",
      "top: 0;",
      `width: ${width}px;`,
      `height: ${height}px;`,
      "overflow: hidden;",
      `background: ${cssColor(scene.background?.color ?? "background")};`,
      "color: var(--c-foreground);",
      `font-family: ${markup.fontStacks.body};`,
    ]),
    cssRule(`#${stageId} .underlay, #${stageId} .underlay > *`, ["position: absolute;", "inset: 0;"]),
    cssRule(`#${stageId} .content`, [
      "position: absolute;",
      `inset: ${contentInset(input, safe, gap)};`,
      "display: flex;",
      "flex-direction: column;",
      `gap: ${gap}px;`,
    ]),
    cssRule(`#${stageId} .region`, [
      "display: flex;",
      "flex-direction: column;",
      `gap: ${gap}px;`,
      "min-height: 0;",
    ]),
    cssRule(`#${stageId} .region-middle`, ["flex: 1 1 auto;", "justify-content: center;"]),
    cssRule(`#${stageId} .lane`, ["display: grid;", "align-items: center;"]),
    cssRule(`#${stageId} .lane > .shot`, ["grid-area: 1 / 1;"]),
  ];

  const underlay: string[] = [];
  if (scene.background?.assetId) {
    const src = markup.assetPaths.get(scene.background.assetId);
    if (src) {
      underlay.push(
        markup.videoAssetIds.has(scene.background.assetId)
          ? videoClipTag({
              id: `${prefix}bg-clip`,
              className: "bg",
              src,
              startMs: 0,
              durationMs: scene.durationMs,
            })
          : `<img class="bg" src="${escapeHtml(src)}" alt="" />`,
      );
      css.push(cssRule(`#${stageId} .bg`, ["width: 100%;", "height: 100%;", "object-fit: cover;"]));
    }
  }

  const w = new TimelineWriter();
  writeTransition(w, `#${stageId}`, "in", input.transitions.in, scene.durationMs);
  const html = new Map<string, string>();
  for (const shot of scene.shots) {
    const rendered = renderShotMarkup(ctx, shot);
    html.set(shot.id, rendered.html);
    css.push(...rendered.css);
    const align = shot.style?.align ?? "center";
    css.push(cssRule(`#${shotDomId(prefix, shot.id)}`, [`justify-self: ${JUSTIFY[align]};`]));
    // Full-bleed shots sit in the underlay behind the flowing regions.
    if (shot.style?.region === "full") underlay.push(rendered.html);
    writeShotMotion(w, `#${shotDomId(prefix, shot.id)}`, shot, scene.durationMs, markup.frame);
    if (shot.type === "layout") writeLayoutMotion(w, `#${shotDomId(prefix, shot.id)}`, shot, markup.frame);
  }

  const regions = REGIONS.map((region) => {
    const shots = scene.shots.filter((s) => (s.style?.region ?? "middle") === region);
    const lanes = assignLanes(shots).map(
      (lane) => `<div class="lane">${lane.map((s) => html.get(s.id)).join("")}</div>`,
    );
    return `<div class="region region-${region}">${lanes.join("")}</div>`;
  });

  const captionHtml = captionsMarkup(input, stageId, prefix, css, w);
  writeTransition(w, `#${stageId}`, "out", input.transitions.out, scene.durationMs);

  const script = [
    "(function () {",
    "  var tl = gsap.timeline({ paused: true });",
    ...w.lines.map((l) => `  ${l}`),
    `  tl.set({}, {}, ${num(seconds(scene.durationMs))});`,
    "  window.__timelines = window.__timelines || {};",
    `  window.__timelines[${scriptJson(scene.id)}] = tl;`,
    "})();",
  ].join("\n");

  const body = (fontCss: string) =>
    [
      `<template id="${prefix}template">`,
      `  <div data-composition-id="${scene.id}" data-width="${width}" data-height="${height}" data-duration="${num(seconds(scene.durationMs))}">`,
      `    <div id="${stageId}" data-scene-role="${scene.role}">`,
      `      <div class="underlay">${underlay.join("")}</div>`,
      `      <div class="content">${regions.join("")}</div>`,
      captionHtml ? `      ${captionHtml}` : "",
      "    </div>",
      "    <style>",
      indent([fontCss, ...css].filter(Boolean).join("\n"), 6),
      "    </style>",
      "    <script>",
      indent(script, 6),
      "    </script>",
      "  </div>",
      "</template>",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n")
      .concat("\n");

  return { path: `compositions/${scene.id}.html`, body };
}

/**
 * Inset of the flowing regions: the safe margin, and on the edge the burned captions sit at, the band the
 * longest cue of the scene takes (one or two lines, plus a gap), so a headline or layout never runs under a cue.
 */
function contentInset(input: SceneCompileInput, safe: number, gap: number): string {
  const { cues, position } = input.captions;
  if (cues.length === 0 || position === "middle") return `${safe}px`;
  const { frame, scale } = input.markup;
  const edge = Math.round(0.09 * Math.min(frame.width, frame.height));
  const sizePx = CAPTION_CUE.sizeAt1080 * scale;
  // Lines the longest cue wraps to (at most two), taking a caption glyph as about 0.55em wide.
  const room = frame.width - 2 * edge - 2 * Math.round(24 * scale);
  const longest = Math.max(...cues.map((c) => Array.from(c.text).length));
  const lines = Math.min(2, Math.max(1, Math.ceil((longest * 0.55 * sizePx) / room)));
  const chip = Math.round(sizePx * CAPTION_CUE.lineHeight) * lines + 2 * Math.round(10 * scale);
  const band = `${Math.max(safe, edge + chip + gap)}px`;
  return position === "top" ? `${band} ${safe}px ${safe}px` : `${safe}px ${safe}px ${band}`;
}

/**
 * Burned caption type: larger and heavier than the `caption` text style, because a cue is read in passing,
 * often on a phone showing a landscape video at a third of its size. 48px at 1080 is about 4.4% of the
 * short edge, the size subtitles are set at for small screens.
 */
const CAPTION_CUE = { ...TEXT_STYLES.caption, sizeAt1080: 48, weight: 600, lineHeight: 1.3 } as const;

/** Burned captions: one hidden line per cue, shown for its scene-local window above all shots. */
function captionsMarkup(
  input: SceneCompileInput,
  stageId: string,
  prefix: string,
  css: string[],
  w: TimelineWriter,
): string {
  const { cues, position } = input.captions;
  if (cues.length === 0) return "";
  const { frame, fontStacks, fontWeights, scale } = input.markup;
  const token = CAPTION_CUE;
  fontWeights[token.font].add(token.weight);
  const edge = Math.round(0.09 * Math.min(frame.width, frame.height));
  const placement =
    position === "top" ? [`top: ${edge}px;`] : position === "middle" ? ["top: 50%;"] : [`bottom: ${edge}px;`];
  css.push(
    cssRule(`#${stageId} .captions`, [
      "position: absolute;",
      `left: ${edge}px;`,
      `right: ${edge}px;`,
      ...placement,
      "display: grid;",
      "justify-items: center;",
    ]),
    cssRule(`#${stageId} .cue`, [
      "grid-area: 1 / 1;",
      "opacity: 0;",
      `font-family: ${fontStacks[token.font]};`,
      `font-size: ${Math.round(token.sizeAt1080 * scale)}px;`,
      `font-weight: ${token.weight};`,
      `line-height: ${token.lineHeight};`,
      "color: #ffffff;",
      "background: rgba(0, 0, 0, 0.72);",
      `padding: ${Math.round(10 * scale)}px ${Math.round(24 * scale)}px;`,
      `border-radius: ${Math.round(14 * scale)}px;`,
      "text-align: center;",
      "white-space: pre-line;",
      "hyphens: manual;",
    ]),
  );
  const lines = cues.map((cue, i) => {
    const id = `${prefix}cue-${i}`;
    w.set(`#${id}`, { opacity: 1 }, seconds(cue.startMs));
    if (cue.endMs < input.scene.durationMs) w.set(`#${id}`, { opacity: 0 }, seconds(cue.endMs));
    return `<div id="${id}" class="cue">${escapeHtml(cue.text)}</div>`;
  });
  return `<div class="captions">${lines.join("")}</div>`;
}
