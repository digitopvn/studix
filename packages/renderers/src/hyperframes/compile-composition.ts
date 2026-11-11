// Adapted from motion-mcp packages/hyperframes-adapter/src/compile.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StudixError } from "@studix/shared";
import { resolveSceneSpans, type VideoIR } from "@studix/video-ir";
import {
  DEFAULT_FONT_FAMILY,
  type FontSlot,
  frameScale,
  resolvePalette,
  TEXT_STYLES,
} from "./brand-tokens.ts";
import { planFonts } from "./bundled-fonts.ts";
import { cmp, escapeHtml, num, scriptJson, seconds } from "./html-utils.ts";
import { compileScene, type SceneCaptionCue } from "./scene-composition.ts";
import { sceneTransitions } from "./scene-timeline.ts";

const require = createRequire(import.meta.url);

export const ROOT_COMPOSITION_ID = "main";
export const GSAP_ASSET = "assets/vendor/gsap.min.js";

/** Image MIME types the browser renders natively, mapped to the file extension used in the project. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

/** Video MIME types HyperFrames can extract frames from, mapped to the file extension used in the project. */
export const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

export interface BuildCompositionOptions {
  /** Output frame size (the render size); type and layout scale from it. */
  width: number;
  height: number;
  /** IR asset id -> absolute local file path (downloaded and hash-verified by the caller). */
  assetFiles?: Readonly<Record<string, string>>;
}

/** In-memory HyperFrames project: deterministic for a given IR and options. */
export interface CompositionBuild {
  /** Project-relative path -> text content. */
  files: Map<string, string>;
  /** Project-relative destination -> absolute source file to copy. */
  copies: Map<string, string>;
  durationMs: number;
  width: number;
  height: number;
  warnings: string[];
}

/** Scene-local burned caption cues, split at scene boundaries. */
function captionsByScene(ir: VideoIR): Map<string, SceneCaptionCue[]> {
  const result = new Map<string, SceneCaptionCue[]>();
  if (ir.captions?.mode !== "burned") return result;
  for (const span of resolveSceneSpans(ir.timeline, ir.scenes)) {
    const cues = ir.captions.cues
      .filter((cue) => cue.startMs < span.endMs && cue.endMs > span.startMs)
      .map((cue) => ({
        startMs: Math.max(cue.startMs, span.startMs) - span.startMs,
        endMs: Math.min(cue.endMs, span.endMs) - span.startMs,
        text: cue.text,
      }));
    result.set(span.sceneId, cues);
  }
  return result;
}

function indexHtml(ir: VideoIR, width: number, height: number, background: string): string {
  const spans = new Map(resolveSceneSpans(ir.timeline, ir.scenes).map((s) => [s.sceneId, s]));
  const duration = num(seconds(ir.format.durationMs));
  const hosts = ir.timeline.entries.map((entry) => {
    const span = spans.get(entry.sceneId)!;
    return [
      `      <div id="scene-${entry.sceneId}" class="scene-host" data-composition-id="${entry.sceneId}"`,
      `        data-composition-src="compositions/${entry.sceneId}.html" data-start="${num(seconds(span.startMs))}"`,
      `        data-duration="${num(seconds(span.endMs - span.startMs))}" data-track-index="1"></div>`,
    ].join("\n");
  });
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(ir.language)}">`,
    "  <head>",
    '    <meta charset="UTF-8" />',
    `    <meta name="viewport" content="width=${width}, height=${height}" />`,
    `    <title>${escapeHtml(ir.title)}</title>`,
    `    <script src="${GSAP_ASSET}"></script>`,
    "    <style>",
    `      html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }`,
    `      #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: ${background}; }`,
    `      .scene-host { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; }`,
    "    </style>",
    "  </head>",
    "  <body>",
    `    <div id="root" data-composition-id="${ROOT_COMPOSITION_ID}" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">`,
    ...hosts,
    "    </div>",
    "    <script>",
    "      (function () {",
    "        var tl = gsap.timeline({ paused: true });",
    `        tl.set({}, {}, ${duration});`,
    "        window.__timelines = window.__timelines || {};",
    `        window.__timelines[${scriptJson(ROOT_COMPOSITION_ID)}] = tl;`,
    "      })();",
    "    </script>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/** Compile a validated VideoIR into HyperFrames project files without touching the filesystem. */
export function buildComposition(ir: VideoIR, options: BuildCompositionOptions): CompositionBuild {
  const { width, height } = options;
  const warnings: string[] = [];
  const palette = resolvePalette(ir.brand);
  const families: Record<FontSlot, string> = {
    heading: ir.brand?.fonts.heading ?? DEFAULT_FONT_FAMILY,
    body: ir.brand?.fonts.body ?? DEFAULT_FONT_FAMILY,
  };
  // Stacks are needed while rendering shots; files are planned after shots report the weights they use.
  const namePlan = planFonts([
    { family: families.heading, weights: new Set() },
    { family: families.body, weights: new Set() },
  ]);
  const fontStacks: Record<FontSlot, string> = {
    heading: namePlan.stacks.get(families.heading)!,
    body: namePlan.stacks.get(families.body)!,
  };
  const fontWeights: Record<FontSlot, Set<number>> = { heading: new Set(), body: new Set() };

  const copies = new Map<string, string>();
  const assetPaths = new Map<string, string>();
  const videoAssetIds = new Set<string>();
  for (const asset of [...ir.assets].sort((a, b) => cmp(a.id, b.id))) {
    const source = options.assetFiles?.[asset.id];
    const ext =
      asset.kind === "image"
        ? IMAGE_EXTENSIONS[asset.mime]
        : asset.kind === "video"
          ? VIDEO_EXTENSIONS[asset.mime]
          : undefined;
    if (!source || !ext) continue;
    if (!isAbsolute(source)) {
      throw new StudixError("VALIDATION", `Asset file for "${asset.id}" must be an absolute path`);
    }
    const dest = `assets/media/${asset.id}${ext}`;
    copies.set(dest, source);
    assetPaths.set(asset.id, dest);
    if (asset.kind === "video") videoAssetIds.add(asset.id);
  }

  const cues = captionsByScene(ir);
  const position = ir.captions?.position ?? "bottom";
  const markup = {
    scale: frameScale({ width, height }),
    frame: { width, height },
    fontStacks,
    fontWeights,
    assetPaths,
    brand: ir.brand,
    language: ir.language,
    palette,
  };
  const scenes = ir.scenes.map((scene, index) =>
    compileScene({
      scene,
      palette,
      transitions: sceneTransitions(ir.scenes, index),
      captions: { position, cues: cues.get(scene.id) ?? [] },
      markup: { ...markup, videoAssetIds },
    }),
  );

  // Every scene stage names the body family, so it needs a bundled face even when no shot draws text;
  // otherwise the producer injects one itself, which can mean a network font fetch.
  if (fontWeights.body.size === 0) fontWeights.body.add(TEXT_STYLES.body.weight);
  const fonts = planFonts([
    { family: families.heading, weights: fontWeights.heading },
    { family: families.body, weights: fontWeights.body },
  ]);
  warnings.push(...fonts.warnings);
  for (const f of fonts.files) copies.set(f.dest, f.source);
  copies.set(GSAP_ASSET, require.resolve("gsap/dist/gsap.min.js"));

  const files = new Map<string, string>();
  const firstScene = ir.scenes.find((s) => s.id === ir.timeline.entries[0]?.sceneId);
  const rootBackground = firstScene?.background?.color ?? "background";
  files.set(
    "index.html",
    indexHtml(
      ir,
      width,
      height,
      rootBackground.startsWith("#") ? rootBackground : palette[rootBackground as keyof typeof palette],
    ),
  );
  for (const scene of scenes) files.set(scene.path, scene.body(fonts.css));

  return { files, copies, durationMs: ir.format.durationMs, width, height, warnings };
}

/** Write a built composition into `projectDir` (created if missing). Returns the sorted file list. */
export async function writeComposition(build: CompositionBuild, projectDir: string): Promise<string[]> {
  const root = resolve(projectDir);
  try {
    for (const [rel, content] of build.files) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content, "utf8");
    }
    for (const [rel, source] of build.copies) {
      const info = await stat(source);
      if (!info.isFile()) throw new Error(`${source} is not a file`);
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await copyFile(source, join(root, rel));
    }
  } catch (err) {
    throw new StudixError("INTERNAL", "Failed to write the HyperFrames composition", {
      cause: err,
      details: { projectDir: root, reason: err instanceof Error ? err.message : String(err) },
    });
  }
  return [...build.files.keys(), ...build.copies.keys()].sort(cmp);
}
