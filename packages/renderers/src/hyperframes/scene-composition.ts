// Adapted from motion-mcp packages/hyperframes-adapter/src/compile.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import type { ColorRole, Scene, Shot } from "@studix/video-ir";
import { COLOR_ROLES, cssColor, TEXT_STYLES } from "./brand-tokens.ts";
import { cssRule, escapeHtml, indent, num, scriptJson, seconds } from "./html-utils.ts";
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
  const ctx: ShotMarkupContext = { ...markup, prefix };
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
      `inset: ${safe}px;`,
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
  const token = TEXT_STYLES.caption;
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
      "background: rgba(0, 0, 0, 0.6);",
      `padding: ${Math.round(8 * scale)}px ${Math.round(18 * scale)}px;`,
      `border-radius: ${Math.round(10 * scale)}px;`,
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
