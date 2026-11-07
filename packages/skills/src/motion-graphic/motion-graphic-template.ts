import { StudixError } from "@studix/shared";
import {
  ASPECT_RATIO_SIZES,
  type AspectRatio,
  type AssetRef,
  type BrandKit,
  type BrandPalette,
  buildSequentialTimeline,
  type CaptionCue,
  type ColorRole,
  type CreativeBrief,
  type MotionPreset,
  type Scene,
  type SceneTransition,
  type Shot,
  unwrapValidation,
  type VideoIR,
  validateCreativeBrief,
  validateVideoIR,
} from "@studix/video-ir";
import { DEFAULT_BRAND_FONTS } from "../brand-intro/brief-draft.ts";
import { captionCues, wordCount } from "../caption-chunks.ts";
import { VO_PAD_MS, VO_WORDS_PER_SECOND, voiceoverWordBudget } from "../marketing-video/marketing-script.ts";
import { breakLines, detectLanguage, truncateText } from "../vietnamese-safe-text.ts";
import { MOTION_STYLE_PROFILES, type MotionStyleProfile } from "./motion-style-profiles.ts";

export const MOTION_GRAPHIC_TEMPLATE_VERSION = 3;
export const MOTION_GRAPHIC_DEFAULT_MS = 15_000;
export const MOTION_GRAPHIC_MIN_MS = 6_000;
export const MOTION_GRAPHIC_MAX_MS = 60_000;
const DEFAULT_STYLE = "kinetic-typography";
const FPS = 30;
const LINE_CHARS: Record<AspectRatio, number> = { "9:16": 20, "1:1": 22, "16:9": 34 };

const words = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);

/**
 * The style profile of a brief: the profile its first direction names in `visualStyle`, else the one whose
 * use cases and look share the most words with the brief's tone, objective and prompt, else kinetic
 * typography (words as the visuals, the natural fit for a voice-over-led graphic). Deterministic.
 */
export function resolveMotionStyle(brief: CreativeBrief): MotionStyleProfile {
  const named = brief.directions?.[0]?.visualStyle?.trim().toLowerCase();
  const exact = MOTION_STYLE_PROFILES.find((p) => p.id === named);
  if (exact) return exact;
  const wanted = new Set(
    words([...(brief.tone ?? []), brief.objective ?? "", named ?? "", brief.prompt].join(" ")),
  );
  let best: MotionStyleProfile | undefined;
  let bestScore = 0;
  for (const profile of MOTION_STYLE_PROFILES) {
    const score = words([...profile.bestFor, profile.summary].join(" ")).filter((w) => wanted.has(w)).length;
    if (score > bestScore) {
      best = profile;
      bestScore = score;
    }
  }
  return best ?? (MOTION_STYLE_PROFILES.find((p) => p.id === DEFAULT_STYLE) as MotionStyleProfile);
}

/** GSAP presets and the scene transition an energy level calls for (calm fades .. hard pops). */
function motionFor(energy: number): { enter: MotionPreset; exit: MotionPreset; transition: SceneTransition } {
  if (energy <= 2) return { enter: "fade", exit: "fade", transition: { kind: "fade", durationMs: 500 } };
  if (energy === 3)
    return { enter: "slide-up", exit: "fade", transition: { kind: "slide", durationMs: 350 } };
  return { enter: "pop", exit: "scale", transition: { kind: "zoom", durationMs: 250 } };
}

interface Line {
  onScreen: string;
  voiceover?: string;
}

/** On-screen lines and their voice-over: the first direction's beats, else the title, messages and CTA. */
function linesOf(brief: CreativeBrief, cta: string): Line[] {
  const beats = brief.directions?.[0]?.beats;
  if (beats) {
    return beats.map((b) => ({
      onScreen: b.onScreen ?? truncateText(b.voiceover ?? b.visual, 120),
      ...(b.voiceover ? { voiceover: b.voiceover } : {}),
    }));
  }
  const hook =
    brief.directions?.[0]?.hook ?? brief.title ?? brief.brand?.tagline ?? truncateText(brief.prompt, 80);
  const messages = (brief.directions?.[0]?.keyMessages ?? brief.keyMessages ?? []).slice(0, 4);
  return [hook, ...messages, cta].map((text) => ({ onScreen: truncateText(text, 120), voiceover: text }));
}

/** WCAG relative luminance of a `#rrggbb[aa]` colour (alpha ignored). */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for large text, which every motion-graphic line is. */
const MIN_CONTRAST = 3;

/**
 * The palette role to set text in on a scene colour: the wanted role when it reads (WCAG AA large text),
 * else whichever of foreground and background contrasts more. Brand palettes pair foreground with
 * background, so dark ink on a dark primary would otherwise vanish.
 */
function inkOn(
  palette: BrandPalette,
  scene: "background" | "primary",
  wanted: "foreground" | "accent",
): ColorRole {
  const fill = palette[scene];
  const colour = palette[wanted];
  if (colour && contrast(colour, fill) >= MIN_CONTRAST) return wanted;
  return contrast(palette.foreground, fill) >= contrast(palette.background, fill)
    ? "foreground"
    : "background";
}

/**
 * Card lengths: each card gets the time its voice-over takes to say (with the lead-in and closing pads),
 * and the rest of the length is shared equally, so a long hook never shares an even split with a two-word
 * call to action and outruns its card.
 */
function durations(totalMs: number, lines: readonly Line[]): number[] {
  const last = lines.length - 1;
  const need = lines.map(
    (l, i) =>
      (l.voiceover ? (wordCount(l.voiceover) / VO_WORDS_PER_SECOND) * 1000 : 0) +
      (i === 0 ? VO_PAD_MS : 0) +
      (i === last ? VO_PAD_MS : 0),
  );
  const slack = Math.max(0, totalMs - need.reduce((a, b) => a + b, 0)) / lines.length;
  const out = need.map((n) => Math.floor((n + slack) / 100) * 100);
  out[last] = totalMs - out.slice(0, last).reduce((a, b) => a + b, 0);
  return out;
}

export interface MotionGraphicOptions {
  /** IR assets the brief may reference; only an image matching `brand.logoAssetId` is used. */
  assets?: readonly AssetRef[];
}

/**
 * HTML/GSAP-first motion graphic: kinetic title, message and CTA cards in a resolved style profile, with a
 * voice-over script and burned captions (the voice itself is generated by the pack's voice-over stage).
 * Pure. Throws VALIDATION when the voice-over does not fit the length.
 */
export function motionGraphicTemplate(input: unknown, options: MotionGraphicOptions = {}): VideoIR {
  const brief = unwrapValidation(validateCreativeBrief(input), "creative brief");
  const aspectRatio = brief.aspectRatio ?? "9:16";
  const totalMs = Math.min(
    MOTION_GRAPHIC_MAX_MS,
    Math.max(MOTION_GRAPHIC_MIN_MS, brief.durationMs ?? MOTION_GRAPHIC_DEFAULT_MS),
  );
  const language = brief.language ?? detectLanguage([brief.prompt, ...(brief.keyMessages ?? [])].join(" "));
  const cta =
    brief.directions?.[0]?.callToAction ??
    brief.callToAction ??
    (language.startsWith("vi") ? "Tìm hiểu ngay" : "Learn more");
  const style = resolveMotionStyle(brief);
  const motion = motionFor(style.energy);
  const lines = linesOf(brief, cta).slice(0, 8);
  const voiceover = lines
    .map((l) => l.voiceover)
    .filter(Boolean)
    .join(" ");
  const budget = voiceoverWordBudget(totalMs);
  if (wordCount(voiceover) > budget) {
    throw new StudixError("VALIDATION", `Voice-over is longer than a ${totalMs / 1000}s graphic can hold`, {
      retryable: false,
      details: { wordBudget: budget, words: wordCount(voiceover) },
      suggestedAction: `Cut the voice-over to at most ${budget} words (about ${VO_WORDS_PER_SECOND} words a second), or lengthen the video.`,
    });
  }
  const brand: BrandKit = brief.brand ?? {
    name: truncateText(brief.title ?? style.name, 120),
    palette: {
      primary: style.palette.accent,
      accent: style.palette.accent,
      background: style.palette.background,
      foreground: style.palette.foreground,
    },
    fonts: DEFAULT_BRAND_FONTS,
  };
  const logo = brand.logoAssetId
    ? options.assets?.find((a) => a.id === brand.logoAssetId && a.kind === "image")
    : undefined;
  const { logoAssetId: _unused, ...brandNoLogo } = brand;
  const chars = LINE_CHARS[aspectRatio];
  const spans = durations(totalMs, lines);
  const last = lines.length - 1;
  let cursor = 0;
  const cues: CaptionCue[] = [];
  const scenes: Scene[] = lines.map((line, i): Scene => {
    const durationMs = spans[i] as number;
    const startAt = cursor;
    cursor += durationMs;
    if (line.voiceover) {
      const pad = i === 0 ? VO_PAD_MS : 0;
      const tail = i === last ? VO_PAD_MS : 0;
      cues.push(...captionCues(line.voiceover, startAt + pad, durationMs - pad - tail));
    }
    const id = i === 0 ? "hook" : i === last ? "cta" : `message-${i}`;
    const fill = i % 2 === 0 ? "background" : "primary";
    const shots: Shot[] = [];
    if (i === last) {
      shots.push({
        id: "cta-logo",
        type: "logo",
        startMs: 0,
        durationMs,
        ...(logo ? { assetId: logo.id } : { text: truncateText(brand.name, 60) }),
        style: {
          textStyle: "heading",
          color: inkOn(brand.palette, fill, "accent"),
          align: "center",
          region: "top",
        },
        animation: { enter: motion.enter, durationMs: 400 },
      });
      shots.push({
        id: "cta-text",
        type: "cta",
        startMs: 300,
        durationMs: durationMs - 300,
        text: breakLines(line.onScreen, chars - 2).slice(0, 120),
        style: {
          textStyle: "heading",
          color: inkOn(brand.palette, fill, "foreground"),
          align: "center",
          region: "middle",
          emphasis: "high",
        },
        animation: { enter: motion.enter, durationMs: 400 },
      });
    } else {
      shots.push({
        id: `${id}-text`,
        type: i === 0 ? "title" : "text",
        startMs: 0,
        durationMs,
        text: breakLines(line.onScreen, chars).slice(0, i === 0 ? 160 : 500),
        style: {
          textStyle: i === 0 ? "display" : "heading",
          color: inkOn(brand.palette, fill, "foreground"),
          align: "center",
          region: "middle",
        },
        animation: { enter: i === 0 ? "scale" : motion.enter, exit: motion.exit, durationMs: 400 },
      });
    }
    return {
      id,
      role: i === 0 ? "hook" : i === last ? "cta" : "feature",
      durationMs,
      background: { color: fill },
      shots,
      ...(i === last ? {} : { transitionOut: motion.transition }),
    };
  });
  const ir: VideoIR = {
    schemaVersion: 1,
    title: truncateText(brief.title ?? brand.name, 200),
    language,
    format: { aspectRatio, ...ASPECT_RATIO_SIZES[aspectRatio], fps: FPS, durationMs: totalMs },
    brand: logo ? brand : brandNoLogo,
    assets: logo ? [logo] : [],
    scenes,
    timeline: buildSequentialTimeline(scenes),
    ...(cues.length > 0 ? { captions: { language, mode: "burned", position: "bottom", cues } } : {}),
    metadata: {
      template: "motion-graphic",
      templateVersion: MOTION_GRAPHIC_TEMPLATE_VERSION,
      styleProfile: style.id,
      bpm: style.bpm,
      ...(voiceover ? { voiceover } : {}),
    },
  };
  const result = validateVideoIR(ir);
  if (!result.ok) {
    throw new StudixError("INTERNAL", "The motion-graphic template produced an invalid IR", {
      details: { issues: result.issues.slice(0, 10) },
    });
  }
  return result.value;
}
