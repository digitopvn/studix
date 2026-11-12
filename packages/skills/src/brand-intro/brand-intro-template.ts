import { schemaFailure } from "@studix/shared";
import {
  ASPECT_RATIO_SIZES,
  type AspectRatio,
  type AssetRef,
  type BrandKit,
  buildSequentialTimeline,
  type CreativeBrief,
  type Scene,
  type Shot,
  unwrapValidation,
  type VideoIR,
  validateCreativeBrief,
  validateVideoIR,
} from "@studix/video-ir";
import { breakLines, detectLanguage } from "../vietnamese-safe-text.ts";
import { selectBrandIntroCopy } from "./brand-intro-copy.ts";

export const BRAND_INTRO_TEMPLATE_VERSION = 1;
export const BRAND_INTRO_MIN_MS = 6_000;
export const BRAND_INTRO_MAX_MS = 15_000;
const SCENE_MS = 3_000;
/** Shortest scene that still reads comfortably; it sets how many key messages fit a requested length. */
const READABLE_SCENE_MS = 2_500;
const TRANSITION_MS = 300;
const FPS = 30;

/**
 * Characters per line by text role, sized for the renderer's type scale at the frame's short edge with a
 * 7% safe inset (9:16 and 1:1 share a 1080px-wide frame). Kept conservative for heavy display weights.
 */
const LINE_CHARS: Record<AspectRatio, { display: number; heading: number; body: number }> = {
  "9:16": { display: 14, heading: 22, body: 30 },
  "1:1": { display: 14, heading: 22, body: 30 },
  "16:9": { display: 24, heading: 36, body: 48 },
};

export interface BrandIntroOptions {
  /** IR assets the brief may reference; only an image matching `brand.logoAssetId` is used. */
  assets?: readonly AssetRef[];
}

/** Scene durations in whole 100ms steps; the outro absorbs the rounding remainder. */
function sceneDurations(totalMs: number, sceneCount: number): number[] {
  const base = Math.floor(totalMs / sceneCount / 100) * 100;
  const durations = Array.from({ length: sceneCount }, () => base);
  durations[sceneCount - 1] = totalMs - base * (sceneCount - 1);
  return durations;
}

function resolveBrand(brand: BrandKit | undefined, assets: readonly AssetRef[], notes: string[]) {
  if (!brand) return { brand: undefined, logo: undefined };
  if (!brand.logoAssetId) return { brand, logo: undefined };
  const logo = assets.find((a) => a.id === brand.logoAssetId && a.kind === "image");
  if (logo) return { brand, logo };
  notes.push(`logo asset "${brand.logoAssetId}" was not supplied; the outro uses the brand wordmark`);
  const { logoAssetId: _dropped, ...rest } = brand;
  return { brand: rest, logo: undefined };
}

/**
 * Deterministic brand-intro template: a title card, two or three key-message scenes and a CTA outro,
 * 6–15s long, in the brief's aspect ratio (default 9:16) and brand palette. Pure: the same brief and
 * options always produce the same IR, and the input is never mutated. The result is checked with
 * validateVideoIR; a failure there is a template bug and surfaces as INTERNAL.
 */
export function brandIntroTemplate(input: unknown, options: BrandIntroOptions = {}): VideoIR {
  const brief: CreativeBrief = unwrapValidation(validateCreativeBrief(input), "creative brief");
  const notes: string[] = [];
  const aspectRatio = brief.aspectRatio ?? "9:16";
  const lines = LINE_CHARS[aspectRatio];

  let totalMs: number | undefined;
  if (brief.durationMs !== undefined) {
    totalMs = Math.min(BRAND_INTRO_MAX_MS, Math.max(BRAND_INTRO_MIN_MS, brief.durationMs));
    if (totalMs !== brief.durationMs) notes.push(`duration ${brief.durationMs}ms clamped to ${totalMs}ms`);
  }
  const maxMessages =
    totalMs === undefined ? 3 : Math.min(3, Math.max(2, Math.floor(totalMs / READABLE_SCENE_MS) - 2));
  const language =
    brief.language ??
    detectLanguage(
      [brief.title, brief.brand?.name, brief.brand?.tagline, ...(brief.keyMessages ?? []), brief.prompt].join(
        " ",
      ),
    );
  const copy = selectBrandIntroCopy(brief, language, maxMessages);
  if (copy.filledMessages > 0)
    notes.push(`${copy.filledMessages} key message(s) filled from template defaults`);
  if (copy.droppedMessages > 0)
    notes.push(`${copy.droppedMessages} key message(s) left out to fit ${maxMessages} message scenes`);
  const { brand, logo } = resolveBrand(brief.brand, options.assets ?? [], notes);

  const sceneCount = copy.messages.length + 2;
  totalMs ??= sceneCount * SCENE_MS;
  const durations = sceneDurations(totalMs, sceneCount);
  const fade = { kind: "fade", durationMs: TRANSITION_MS } as const;

  const titleMs = durations[0]!;
  const scenes: Scene[] = [
    {
      id: "title",
      role: "intro",
      durationMs: titleMs,
      background: { color: "background" },
      shots: [
        {
          id: "title-card",
          type: "title",
          startMs: 0,
          durationMs: titleMs,
          text: breakLines(copy.title, lines.display),
          ...(copy.subtitle ? { subtitle: breakLines(copy.subtitle, lines.body) } : {}),
          style: { textStyle: "display", color: "foreground", align: "center", region: "middle" },
          animation: { enter: "scale", durationMs: 500 },
        },
      ],
      transitionOut: fade,
    },
    ...copy.messages.map((message, i): Scene => {
      const durationMs = durations[i + 1]!;
      const last = i === copy.messages.length - 1;
      return {
        id: `message-${i + 1}`,
        role: "feature",
        durationMs,
        background: { color: i % 2 === 0 ? "primary" : "background" },
        shots: [
          {
            id: `message-${i + 1}-text`,
            type: "text",
            startMs: 0,
            durationMs,
            text: breakLines(message, lines.heading),
            style: { textStyle: "heading", color: "foreground", align: "center", region: "middle" },
            animation: { enter: "slide-up", durationMs: 400 },
          },
        ],
        transitionOut: last ? fade : { kind: "slide", durationMs: TRANSITION_MS },
      };
    }),
  ];

  const outroMs = durations[sceneCount - 1]!;
  const outroShots: Shot[] = [];
  if (logo || copy.wordmark) {
    outroShots.push({
      id: "outro-logo",
      type: "logo",
      startMs: 0,
      durationMs: outroMs,
      ...(logo ? { assetId: logo.id } : { text: copy.wordmark! }),
      style: { textStyle: "heading", color: "accent", align: "center", region: "top" },
      animation: { enter: "fade", durationMs: 400 },
    });
  }
  const ctaStart = outroShots.length > 0 ? 400 : 0;
  outroShots.push({
    id: "outro-cta",
    type: "cta",
    startMs: ctaStart,
    durationMs: outroMs - ctaStart,
    text: breakLines(copy.cta, lines.heading - 2),
    style: { textStyle: "heading", color: "foreground", align: "center", region: "middle", emphasis: "high" },
    animation: { enter: "pop", durationMs: 400 },
  });
  scenes.push({
    id: "outro",
    role: "cta",
    durationMs: outroMs,
    background: { color: "primary" },
    shots: outroShots,
  });

  const ir: VideoIR = {
    schemaVersion: 1,
    title: copy.documentTitle,
    language,
    format: { aspectRatio, ...ASPECT_RATIO_SIZES[aspectRatio], fps: FPS, durationMs: totalMs },
    ...(brand ? { brand } : {}),
    assets: logo ? [logo] : [],
    scenes,
    timeline: buildSequentialTimeline(scenes),
    metadata: { template: "brand-intro", templateVersion: BRAND_INTRO_TEMPLATE_VERSION, notes },
  };
  const result = validateVideoIR(ir);
  if (!result.ok) {
    throw schemaFailure("INTERNAL", "The brand-intro template produced an invalid IR", result.issues);
  }
  return result.value;
}
