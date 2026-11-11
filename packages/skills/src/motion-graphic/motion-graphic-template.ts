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
import { promptFormatHints } from "../brand-intro/brief-draft-from-prompt.ts";
import { captionCues, spokenLength } from "../caption-chunks.ts";
import {
  spokenMs,
  VO_PAD_MS,
  VO_WORDS_PER_SECOND,
  voiceoverWordBudget,
} from "../marketing-video/marketing-script.ts";
import { breakLines, detectLanguage, truncateText } from "../vietnamese-safe-text.ts";
import type { MotionStoryboard } from "./motion-graphic-storyboard.ts";
import { MOTION_STYLE_PROFILES, type MotionStyleProfile } from "./motion-style-profiles.ts";

export const MOTION_GRAPHIC_TEMPLATE_VERSION = 5;
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
  /** Entrance preset the storyboard chose for this card. */
  enter?: MotionPreset;
  /** Relative length of the card (storyboard weight); even split when absent. */
  weight?: number;
}

/** Shortest card a voiceless graphic shows: time to read a headline. */
const MIN_SILENT_CARD_MS = 1500;

const spokenWords = (line: Line) => (line.voiceover ?? "").trim().split(/\s+/).filter(Boolean);

/**
 * A brief-derived script that fits the length: message cards are dropped from the last one back (the hook
 * and the call to action stay), then the voiced text of the longest line before the call to action is cut a
 * word at a time, the call to action itself last, until the spoken length (`spokenLength`) fits. On-screen text stays whole. A voiceless graphic drops
 * message cards until each card has time to be read.
 */
function fitDerived(lines: readonly Line[], totalMs: number, voiced: boolean, language: string): Line[] {
  const out = [...lines];
  const budget = voiceoverWordBudget(totalMs);
  // Measured like the template's final check: the whole voice-over's spoken length within the budget,
  // and every card's rounded need (`cardNeeds`) inside the length, so no card comes up short of its line.
  const tooLong = (lines: readonly string[][]) => {
    const texts = lines.map((w) => w.join(" "));
    return (
      spokenLength(texts.join(" "), language) > budget ||
      cardNeeds(texts, language).reduce((a, b) => a + b, 0) > totalMs
    );
  };
  const over = () => (voiced ? tooLong(out.map(spokenWords)) : out.length * MIN_SILENT_CARD_MS > totalMs);
  while (out.length > 2 && over()) out.splice(out.length - 2, 1);
  if (!voiced || !tooLong(out.map(spokenWords))) return out;
  const said = out.map(spokenWords);
  const cta = said.length - 1;
  while (tooLong(said)) {
    // The line that takes longest to say (not the one with most words) gives up a word first.
    const spoken = said.map((w) => spokenLength(w.join(" "), language));
    let pick = cta;
    for (let i = 0; i < cta; i++) {
      const n = said[i]?.length ?? 0;
      if (n > 1 && (pick === cta || (spoken[i] ?? 0) > (spoken[pick] ?? 0))) pick = i;
    }
    if ((said[pick]?.length ?? 0) <= 1) break;
    said[pick]?.pop();
  }
  return out.map((l, i) => ({
    ...l,
    voiceover: (said[i] ?? []).join(" ").replace(/[\s,;:–—-]+$/u, ""),
  }));
}

/**
 * On-screen lines and their voice-over: the first direction's beats as written, else the title, messages
 * and CTA fitted to the length. A voiceless brief keeps the on-screen lines only.
 */
function linesOf(brief: CreativeBrief, cta: string, totalMs: number, language: string): Line[] {
  const voiced = brief.voiceover !== false;
  const beats = brief.directions?.[0]?.beats;
  if (beats) {
    return beats.map((b) => ({
      onScreen: b.onScreen ?? truncateText(b.voiceover ?? b.visual, 120),
      ...(voiced && b.voiceover ? { voiceover: b.voiceover } : {}),
    }));
  }
  const hook =
    brief.directions?.[0]?.hook ?? brief.title ?? brief.brand?.tagline ?? truncateText(brief.prompt, 80);
  const messages = (brief.directions?.[0]?.keyMessages ?? brief.keyMessages ?? []).slice(0, 4);
  const lines = [hook, ...messages, cta].map((text) => ({
    onScreen: truncateText(text, 120),
    ...(voiced ? { voiceover: text } : {}),
  }));
  return fitDerived(lines, totalMs, voiced, language);
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

/** Rec.601 luma (0-255) the QA black-frame gate counts as black (mean luma < 16), with headroom. */
const MIN_SCENE_LUMA = 28;

/**
 * A scene fill lifted just off black: a near-black card (e.g. #0e0e0e) with little text on it reads as a
 * black frame to the QA gate, so its channels are raised evenly until its luma clears MIN_SCENE_LUMA.
 */
function offBlack(hex: string): string {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const luma = 0.299 * ch[0]! + 0.587 * ch[1]! + 0.114 * ch[2]!;
  if (luma >= MIN_SCENE_LUMA) return hex;
  const lift = Math.ceil(MIN_SCENE_LUMA - luma);
  return `#${ch
    .map((c) =>
      Math.min(255, c + lift)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
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
 * Time each card needs for its voice-over (`spokenMs`, with the lead-in pad on the first card and the
 * closing pad on the last), rounded up to the 100ms step the cards are cut in. While these sum to at most
 * the length, every card gets at least its need (`durations`).
 */
function cardNeeds(voiceovers: ReadonlyArray<string | undefined>, language: string): number[] {
  const last = voiceovers.length - 1;
  return voiceovers.map(
    (v, i) =>
      Math.ceil(
        ((v ? spokenMs(v, language) : 0) + (i === 0 ? VO_PAD_MS : 0) + (i === last ? VO_PAD_MS : 0)) / 100,
      ) * 100,
  );
}

/**
 * Card lengths in 100ms steps: each card gets the time its voice-over takes to say (with the lead-in and
 * closing pads), and the rest of the length is shared in proportion to the lines' weights (even when
 * unweighted), so a long hook never outruns its card.
 */
function durations(totalMs: number, lines: readonly Line[], language: string): number[] {
  const last = lines.length - 1;
  const need = cardNeeds(
    lines.map((l) => l.voiceover),
    language,
  );
  const weights = lines.map((l) => l.weight ?? 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const slack = Math.max(0, totalMs - need.reduce((a, b) => a + b, 0));
  const out = need.map((n, i) => Math.floor((n + (slack * (weights[i] ?? 1)) / sum) / 100) * 100);
  out[last] = totalMs - out.slice(0, last).reduce((a, b) => a + b, 0);
  return out;
}

export interface MotionGraphicOptions {
  /** IR assets the brief may reference; only an image matching `brand.logoAssetId` is used. */
  assets?: readonly AssetRef[];
  /**
   * The agent's script and storyboard: its style profile, beats (the last is the call to action), entrances
   * and weights replace the brief-derived cards. Absent, the cards come from the brief alone.
   */
  storyboard?: MotionStoryboard;
}

/**
 * The brief with the aspect ratio and length its prompt states filled in where the brief leaves them out,
 * so "a 60-second 16:9 video" is not rendered at the 15 s 9:16 default. Explicit brief fields win.
 */
export function withPromptFormat(brief: CreativeBrief): CreativeBrief {
  if (brief.aspectRatio && brief.durationMs) return brief;
  const hints = promptFormatHints(brief.prompt, {
    minMs: MOTION_GRAPHIC_MIN_MS,
    maxMs: MOTION_GRAPHIC_MAX_MS,
  });
  return { ...hints, ...brief };
}

/**
 * HTML/GSAP-first motion graphic: kinetic title, message and CTA cards in a resolved style profile, with a
 * voice-over script and burned captions (the voice itself is generated by the pack's voice stage), or
 * neither when the brief sets `voiceover: false`. A script derived from the brief is fitted to the length.
 * Pure. Throws VALIDATION when a direction's beats or a storyboard bring a voice-over that does not fit.
 */
export function motionGraphicTemplate(input: unknown, options: MotionGraphicOptions = {}): VideoIR {
  const brief = withPromptFormat(unwrapValidation(validateCreativeBrief(input), "creative brief"));
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
  const storyboard = options.storyboard;
  const style =
    MOTION_STYLE_PROFILES.find((p) => p.id === storyboard?.styleProfile) ?? resolveMotionStyle(brief);
  const motion = motionFor(style.energy);
  const lines: Line[] = storyboard
    ? storyboard.beats.map((b) => ({
        onScreen: b.onScreen,
        ...(brief.voiceover === false ? {} : { voiceover: b.voiceover }),
        enter: b.enter,
        weight: b.weight,
      }))
    : linesOf(brief, cta, totalMs, language).slice(0, 8);
  const voiceover = lines
    .map((l) => l.voiceover)
    .filter(Boolean)
    .join(" ");
  const budget = voiceoverWordBudget(totalMs);
  // Reachable only by a script the template did not derive: a direction's own beats or a storyboard.
  const words = spokenLength(voiceover, language);
  const neededMs = cardNeeds(
    lines.map((l) => l.voiceover),
    language,
  ).reduce((a, b) => a + b, 0);
  if (words > budget || neededMs > totalMs) {
    throw new StudixError("VALIDATION", `Voice-over is longer than a ${totalMs / 1000}s graphic can hold`, {
      retryable: false,
      details: { wordBudget: budget, words, neededMs, totalMs },
      suggestedAction: `Cut the voice-over to at most ${budget} words (about ${VO_WORDS_PER_SECOND} words a second; an English word or brand name counts by its syllables), or lengthen the video.`,
    });
  }
  // What the graphic is called without a brand: its title, else its hook. Never the style profile's name.
  const namedBrand = storyboard?.brandName ?? undefined;
  const unbrandedName = namedBrand ?? brief.title ?? (lines[0]?.onScreen || "Motion graphic");
  const baseBrand: BrandKit = brief.brand ?? {
    name: truncateText(unbrandedName, 120),
    palette: {
      primary: style.palette.accent,
      accent: style.palette.accent,
      background: style.palette.background,
      foreground: style.palette.foreground,
    },
    fonts: DEFAULT_BRAND_FONTS,
  };
  const brand: BrandKit = {
    ...baseBrand,
    palette: {
      ...baseBrand.palette,
      primary: offBlack(baseBrand.palette.primary),
      background: offBlack(baseBrand.palette.background),
    },
  };
  const logo = brand.logoAssetId
    ? options.assets?.find((a) => a.id === brand.logoAssetId && a.kind === "image")
    : undefined;
  const { logoAssetId: _unused, ...brandNoLogo } = brand;
  const chars = LINE_CHARS[aspectRatio];
  const spans = durations(totalMs, lines, language);
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
    const enter = line.enter ?? motion.enter;
    const shots: Shot[] = [];
    if (i === last) {
      // The CTA names the brand only with a logo or a real name: without a brand or title, the brand kit's
      // name is the hook line, which the hook card already shows.
      if (logo || brief.brand || brief.title || namedBrand)
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
          animation: { enter, durationMs: 400 },
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
        animation: { enter, durationMs: 400 },
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
        animation: {
          enter: line.enter ?? (i === 0 ? "scale" : motion.enter),
          exit: motion.exit,
          durationMs: 400,
        },
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
    title: truncateText(brief.title ?? brief.brand?.name ?? unbrandedName, 200),
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
      storyboard: storyboard ? "agent" : "template",
      ...(storyboard?.music ? { music: storyboard.music } : {}),
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
