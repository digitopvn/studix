// Adapted from motion-mcp packages/hyperframes-adapter/src/compile.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import type { ColorRole, Scene, Shot } from "@studix/video-ir";
import {
  BURNED_CAPTION,
  BURNED_CAPTION_PAD,
  burnedCaptionBand,
  burnedCaptionEdge,
  COLOR_ROLES,
  cssColor,
  withBrandSwatches,
} from "./brand-tokens.ts";
import { htmlCardScript } from "./html-card-compile.ts";
import { cssRule, escapeHtml, indent, num, scriptJson, seconds } from "./html-utils.ts";
import { writeLayoutMotion } from "./layout-markup.ts";
import { cameraScales, compileDepth, type Plane, PUSH, planeId, writeCamera } from "./scene-depth.ts";
import {
  type ResolvedTransition,
  TimelineWriter,
  writeShotMotion,
  writeTransition,
} from "./scene-timeline.ts";
import {
  lockupHeight,
  renderShotMarkup,
  type ShotMarkupContext,
  shotDomId,
  videoClipTag,
} from "./shot-markup.ts";

/** A burned-in caption cue in scene-local milliseconds. */
export interface SceneCaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SceneCompileInput {
  scene: Scene;
  /** The scene's place in the video; it fixes where a motif rests at the scene's cuts. */
  sceneIndex: number;
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
  const { width, height } = markup.frame;
  const stageId = `${prefix}stage`;
  const safe = Math.round(0.07 * Math.min(width, height));
  const gap = Math.round(0.03 * Math.min(width, height));
  // A logo lockup over the content (a brand mark on the hook) takes its height from what a layout may fill.
  const lockups = scene.shots.filter((s) => s.type === "logo" && s.lockup && s.style?.region === "top");
  const reserveTop = lockups.length
    ? Math.max(...lockups.map((s) => lockupHeight(s.style?.textStyle ?? "heading", markup.scale))) + gap
    : 0;
  const ctx: ShotMarkupContext = { ...markup, prefix, palette, ...(reserveTop ? { reserveTop } : {}) };
  const captionClearance =
    input.captions.position === "bottom" &&
    input.captions.cues.length > 0 &&
    scene.shots.some((s) => s.type === "layout" && (s.style?.region ?? "middle") === "middle")
      ? Math.max(0, burnedCaptionBand(markup.frame) + gap - safe) +
        // A push grows the shots about the centre, so the layout's bottom edge would sink into the captions.
        (cameraScales(scene.camera) ? Math.ceil((PUSH / 2) * (height - 2 * safe)) : 0)
      : 0;

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
    cssRule(`#${stageId} .region-middle`, [
      "flex: 1 1 auto;",
      "justify-content: center;",
      // A layout fills the middle of its card, so it is centred above the burned captions, never under them.
      ...(captionClearance > 0 ? [`padding-bottom: ${captionClearance}px;`] : []),
    ]),
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
  const depth = compileDepth(w, {
    scene,
    sceneIndex: input.sceneIndex,
    prefix,
    stageId,
    frame: markup.frame,
  });
  css.push(...depth.css);
  const planes = new Set<Plane>(["underlay", "content"]);
  if (depth.back) planes.add("back");
  if (depth.front) planes.add("front");
  writeCamera(w, prefix, scene, markup.frame, planes);
  const html = new Map<string, string>();
  // HTML cards are full-frame layers above the underlay and the regions, below the captions.
  const cards: string[] = [];
  const isCard = (shot: Shot) => shot.type === "composition" && markup.htmlCards?.has(shot.assetId) === true;
  // A swatch row shows only the colours the brand kit really gives.
  for (const shot of scene.shots.map((s) => withBrandSwatches(s, markup.brand))) {
    const rendered = renderShotMarkup(ctx, shot);
    css.push(...rendered.css);
    if (shot.type === "composition" && isCard(shot)) {
      const id = shotDomId(prefix, shot.id);
      cards.push(rendered.html);
      writeShotMotion(w, `#${id}`, shot, scene.durationMs, markup.frame);
      w.lines.push(...htmlCardScript(id, shot, markup.htmlCards!.get(shot.assetId)!));
      continue;
    }
    html.set(shot.id, rendered.html);
    const align = shot.style?.align ?? "center";
    css.push(cssRule(`#${shotDomId(prefix, shot.id)}`, [`justify-self: ${JUSTIFY[align]};`]));
    // Full-bleed shots sit in the underlay behind the flowing regions.
    if (shot.style?.region === "full") underlay.push(rendered.html);
    writeShotMotion(w, `#${shotDomId(prefix, shot.id)}`, shot, scene.durationMs, markup.frame);
    if (shot.type === "layout") writeLayoutMotion(w, `#${shotDomId(prefix, shot.id)}`, shot, markup.frame);
  }

  const regions = REGIONS.map((region) => {
    const shots = scene.shots.filter((s) => !isCard(s) && (s.style?.region ?? "middle") === region);
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
      depth.back ? `      ${depth.back}` : "",
      `      <div id="${planeId(prefix, "underlay")}" class="underlay">${underlay.join("")}</div>`,
      depth.motif ? `      ${depth.motif}` : "",
      `      <div id="${planeId(prefix, "content")}" class="content">${regions.join("")}</div>`,
      // A hero card covers the shots; the front plane and the lens still sit over it, so it shares the look.
      ...cards.map((card) => `      ${card}`),
      depth.front ? `      ${depth.front}` : "",
      depth.lens ? `      ${depth.lens}` : "",
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
  const token = BURNED_CAPTION;
  fontWeights[token.font].add(token.weight);
  const edge = burnedCaptionEdge(frame);
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
      "background: rgba(0, 0, 0, 0.66);",
      `padding: ${Math.round(BURNED_CAPTION_PAD.y * scale)}px ${Math.round(BURNED_CAPTION_PAD.x * scale)}px;`,
      `border-radius: ${Math.round(12 * scale)}px;`,
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
