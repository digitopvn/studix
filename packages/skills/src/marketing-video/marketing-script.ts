import { StudixError } from "@studix/shared";
import {
  type AspectRatio,
  type CreativeBrief,
  type CreativeDirection,
  IrId,
  unwrapValidation,
  validateCreativeBrief,
} from "@studix/video-ir";
import { z } from "zod";
import { wordCount } from "../caption-chunks.ts";
import { detectLanguage, normalizeText, truncateText } from "../vietnamese-safe-text.ts";

export const MARKETING_SCRIPT_VERSION = 1;
/** Length of one ad when the brief names none. */
export const MARKETING_DEFAULT_MS = 20_000;
export const MARKETING_MIN_MS = 10_000;
export const MARKETING_MAX_MS = 60_000;
/**
 * Spoken pace the voice-over budget assumes: about three words a second, the conversational read of the
 * ported script templates. A script over budget is rejected before anything is generated or paid for.
 */
export const VO_WORDS_PER_SECOND = 3;
/** On vertical feeds the hook has to land inside the first three seconds. */
export const HOOK_MAX_MS = 3_000;
/** Silence kept before the first and after the last spoken word of an ad. */
export const VO_PAD_MS = 300;
const MAX_DIRECTIONS = 6;

export const ScriptBeat = z.object({
  id: IrId,
  startMs: z.number().int().min(0),
  durationMs: z.number().int().positive(),
  /** What the frame shows: the image (and later clip) prompt. */
  visual: z.string().min(1).max(600),
  onScreen: z.string().min(1).max(120).optional(),
  voiceover: z.string().min(1).max(400).optional(),
});
export type ScriptBeat = z.infer<typeof ScriptBeat>;

export const ScriptAd = z.object({
  id: IrId,
  name: z.string().min(1).max(120),
  concept: z.string().min(1).max(1000),
  visualStyle: z.string().max(300).optional(),
  callToAction: z.string().min(1).max(200),
  beats: z.array(ScriptBeat).min(2).max(6),
  /** The whole voice-over of the ad, beat lines joined. */
  voiceover: z.string().max(2000),
  voiceoverWords: z.number().int().min(0),
});
export type ScriptAd = z.infer<typeof ScriptAd>;

/** The script of every ad of a marketing brief: the checkpoint the storyboard is drawn from. */
export const MarketingScript = z.object({
  version: z.literal(MARKETING_SCRIPT_VERSION),
  language: z.string().min(2).max(35),
  aspectRatio: z.enum(["9:16", "1:1", "16:9"]),
  /** Length of each ad. */
  durationMs: z.number().int().min(MARKETING_MIN_MS).max(MARKETING_MAX_MS),
  /** Most voice-over words one ad may hold at `VO_WORDS_PER_SECOND`. */
  wordBudget: z.number().int().positive(),
  ads: z.array(ScriptAd).min(1).max(MAX_DIRECTIONS),
});
export type MarketingScript = z.infer<typeof MarketingScript>;

const DEFAULT_CTA: Record<"vi" | "en", string> = { vi: "Tìm hiểu ngay", en: "Learn more" };

/** Words of voice-over an ad of `durationMs` can hold. */
export function voiceoverWordBudget(durationMs: number): number {
  return Math.floor(((durationMs - 2 * VO_PAD_MS) / 1000) * VO_WORDS_PER_SECOND);
}

/** Shot types of the derived message beats, in order, so no two beats of one ad ask for the same still. */
const MESSAGE_SHOTS = ["Close-up detail shot", "Medium shot"] as const;

/**
 * Beats when a direction brings none: hook, up to two messages, the call to action. A visual describes
 * the scene only. The brand name, the hook and the messages are words the overlay sets in the brand's
 * type; put into an image prompt, the model paints them as garbled lettering.
 */
function derivedBeats(direction: CreativeDirection, brief: CreativeBrief, cta: string) {
  const messages = (direction.keyMessages ?? brief.keyMessages ?? [])
    .map(normalizeText)
    .filter(Boolean)
    .slice(0, MESSAGE_SHOTS.length);
  const hook = direction.hook ?? direction.name;
  return [
    { visual: `Wide establishing shot. ${direction.concept}`, onScreen: hook, voiceover: hook },
    ...messages.map((m, i) => ({
      visual: `${MESSAGE_SHOTS[i]}. ${direction.concept}`,
      onScreen: m,
      voiceover: m,
    })),
    {
      // The closing shot stays in the ad's own setting, so the variants do not share one end shot.
      visual: `Hero shot of the product, centred, calm closing composition. ${direction.concept}`,
      onScreen: cta,
      voiceover: cta,
    },
  ];
}

/**
 * The one ad of a brief that names no directions, drawn from the brief itself: the first key message is
 * the hook, the next two are the messages (the derived beats hold no more) and the prompt is the concept.
 * The hook is spoken, so it comes from copy the user wrote for the audience (a key message, else the brand
 * name), never from the prompt, which is an instruction to Studix. Throws VALIDATION when the brief has
 * neither.
 */
function briefDirection(brief: CreativeBrief): CreativeDirection {
  const [first, ...rest] = (brief.keyMessages ?? []).map(normalizeText).filter(Boolean);
  const brand = brief.brand?.name?.trim();
  const hook = first ?? brand;
  if (!hook) {
    throw new StudixError("VALIDATION", "A marketing-video brief needs creative directions or key messages", {
      retryable: false,
      details: { field: "directions" },
      suggestedAction:
        "Add brief.keyMessages (the first one opens the ad), or brief.directions: one { id, name, concept } " +
        "per ad (see studix_inspect schemas).",
    });
  }
  return {
    id: "main",
    name: truncateText(brand || hook, 120),
    concept: truncateText(brief.prompt, 1000),
    hook,
    keyMessages: rest,
  };
}

/**
 * Beat timing: the hook gets at most `HOOK_MAX_MS`, the rest share what is left in whole 100ms steps and
 * the last beat absorbs the rounding remainder.
 */
function beatTimes(count: number, totalMs: number): Array<{ startMs: number; durationMs: number }> {
  const hookMs = Math.min(HOOK_MAX_MS, Math.floor(totalMs / count / 100) * 100);
  const rest = count - 1;
  const each = Math.floor((totalMs - hookMs) / rest / 100) * 100;
  const times = [{ startMs: 0, durationMs: hookMs }];
  for (let i = 0; i < rest; i++) {
    const startMs = hookMs + i * each;
    times.push({ startMs, durationMs: i === rest - 1 ? totalMs - startMs : each });
  }
  return times;
}

/**
 * Script of a marketing brief: one ad per creative direction (one drawn from the brief when it names none),
 * each `durationMs` long (default 20s, 9:16, Vietnamese when the copy is). Deterministic. Throws VALIDATION
 * when no direction can be drawn, or when an ad's voice-over does not fit the word budget, before anything
 * is generated or charged.
 */
export function marketingScript(input: unknown): MarketingScript {
  const brief = unwrapValidation(validateCreativeBrief(input), "creative brief");
  const directions = brief.directions ?? [briefDirection(brief)];
  const aspectRatio: AspectRatio = brief.aspectRatio ?? "9:16";
  const durationMs = Math.min(
    MARKETING_MAX_MS,
    Math.max(MARKETING_MIN_MS, brief.durationMs ?? MARKETING_DEFAULT_MS),
  );
  const sample = [brief.prompt, ...directions.map((d) => `${d.concept} ${d.hook ?? ""}`)].join(" ");
  const language = brief.language ?? detectLanguage(sample);
  const lang = language.startsWith("vi") ? "vi" : "en";
  const wordBudget = voiceoverWordBudget(durationMs);

  const overBudget: Array<{ direction: string; words: number }> = [];
  const ads = directions.map((direction, index): ScriptAd => {
    const cta = direction.callToAction || brief.callToAction?.trim() || DEFAULT_CTA[lang];
    const beats = direction.beats ?? derivedBeats(direction, brief, cta);
    const times = beatTimes(beats.length, durationMs);
    const id = `ad-${index + 1}-${direction.id}`.slice(0, 40).replace(/-+$/, "");
    const scriptBeats = beats.map(
      (beat, i): ScriptBeat => ({
        id: `b${i + 1}`,
        ...(times[i] as { startMs: number; durationMs: number }),
        visual: truncateText(beat.visual, 600),
        ...(beat.onScreen ? { onScreen: truncateText(beat.onScreen, 120) } : {}),
        // A voiceless brief speaks no line, so the ads get no voice-over and no captions read from it.
        ...(beat.voiceover && brief.voiceover !== false ? { voiceover: beat.voiceover } : {}),
      }),
    );
    const voiceover = scriptBeats
      .map((b) => b.voiceover)
      .filter(Boolean)
      .join(" ");
    const words = wordCount(voiceover);
    if (words > wordBudget) overBudget.push({ direction: direction.id, words });
    return {
      id,
      name: direction.name,
      concept: direction.concept,
      ...(direction.visualStyle ? { visualStyle: direction.visualStyle } : {}),
      callToAction: cta,
      beats: scriptBeats,
      voiceover: voiceover.slice(0, 2000),
      voiceoverWords: words,
    };
  });
  if (overBudget.length > 0) {
    throw new StudixError("VALIDATION", `Voice-over is longer than a ${durationMs / 1000}s ad can hold`, {
      retryable: false,
      details: { wordBudget, overBudget },
      suggestedAction: `Cut each ad's voice-over to at most ${wordBudget} words (about ${VO_WORDS_PER_SECOND} words a second).`,
    });
  }
  return { version: MARKETING_SCRIPT_VERSION, language, aspectRatio, durationMs, wordBudget, ads };
}
