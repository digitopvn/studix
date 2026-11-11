import { StudixError } from "@studix/shared";
import { type AssetRef, type AudioTrack, resolveSceneSpans, type VideoIR } from "@studix/video-ir";
import { spokenLength } from "./caption-chunks.ts";
import { MAX_VOICE_SPEEDUP, spokenMs, VO_WORDS_PER_SECOND } from "./marketing-video/marketing-script.ts";

/** What a line of the voice-over does in the video, which sets how it is read. */
export type VoicePart = "hook" | "message" | "cta";

/** One voice-over line: the words of one beat, spoken where that beat's captions run. */
export interface VoiceLine {
  text: string;
  /** Where the line starts: its first caption, i.e. its beat's start (after the lead-in pad on the first). */
  startMs: number;
  /** Longest the line may sound: to its last caption's end, so it never runs into the next beat. */
  roomMs: number;
  part: VoicePart;
  /** Delivery direction for this line, for speech models that take it. */
  instructions: string;
}

const DIRECTION: Readonly<Record<VoicePart, string>> = {
  hook: "open with an intrigued, bright energy that makes the listener lean in",
  message: "carry the message warmly and assuredly, like telling a friend about something you love",
  cta: "land the call to action with an inviting smile in the voice",
};

const DEFAULT_TONE = ["warm", "confident"];
/** Brand tone keywords quoted in the direction; the rest only lengthen it. */
const MAX_TONE_WORDS = 4;
/** Speech routes accept at most this much direction (see the providers' voice params). */
export const MAX_VOICE_DIRECTION_CHARS = 1000;
/**
 * How far a generated line may run past its room and still be laid: speech models end on a breath of
 * silence, which the track cuts with a short fade. Anything longer would be speech spilling into the next
 * beat, so the stage fails instead. Only for a take whose speech could not be measured: a measured one is
 * judged on its speech alone.
 */
export const VOICE_OVERRUN_TOLERANCE_MS = 250;
export { MAX_VOICE_SPEEDUP };

const OVERRUN_FADE_MS = 150;
const SPEDUP_FADE_MS = 40;

/**
 * Beats of the video in order: each scene split where a picture (frame or clip) starts, so one beat of a
 * marketing ad is one clip, and a scene without pictures (a motion-graphic card) is one beat.
 */
function beatSpans(ir: VideoIR): Array<{ startMs: number; endMs: number }> {
  const spans: Array<{ startMs: number; endMs: number }> = [];
  for (const span of resolveSceneSpans(ir.timeline, ir.scenes)) {
    const scene = ir.scenes.find((s) => s.id === span.sceneId);
    const starts = [
      ...new Set([
        0,
        ...(scene?.shots ?? [])
          .filter((sh) => sh.type === "image" || sh.type === "video")
          .map((sh) => sh.startMs),
      ]),
    ].sort((a, b) => a - b);
    starts.forEach((s, i) => {
      const next = starts[i + 1];
      spans.push({ startMs: span.startMs + s, endMs: next === undefined ? span.endMs : span.startMs + next });
    });
  }
  return spans;
}

/** The part a moment of the video plays: its scene's role, else the copy on screen at that moment. */
function partAt(ir: VideoIR, atMs: number): VoicePart {
  const span = resolveSceneSpans(ir.timeline, ir.scenes).find((s) => atMs >= s.startMs && atMs < s.endMs);
  const scene = span ? ir.scenes.find((s) => s.id === span.sceneId) : undefined;
  if (!span || !scene) return "message";
  if (scene.role === "cta" || scene.role === "outro") return "cta";
  if (scene.role === "hook" || scene.role === "intro") return "hook";
  const t = atMs - span.startMs;
  const showing = scene.shots.filter((sh) => sh.startMs <= t && t < sh.startMs + sh.durationMs);
  if (showing.some((sh) => sh.type === "cta" || sh.type === "logo")) return "cta";
  if (showing.some((sh) => sh.type === "title")) return "hook";
  return "message";
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

function direction(ir: VideoIR, part: VoicePart, index: number, count: number, roomMs: number): string {
  const tone = (ir.brand?.voice?.length ? ir.brand.voice : DEFAULT_TONE).slice(0, MAX_TONE_WORDS).join(", ");
  const lead = DIRECTION[part];
  return (
    [
      `Line ${index + 1} of ${count} of a short ${languageName(ir.language)} ad voice-over, read by a native speaker.`,
      `Tone of voice: ${tone}.`,
      "Sound like a real person who means every word, never flat, monotone or robotic.",
      `${lead.charAt(0).toUpperCase()}${lead.slice(1)}.`,
      `Say it in under ${(roomMs / 1000).toFixed(1)} seconds at a natural pace; say the brand name clearly.`,
    ]
      .join(" ")
      // Brand keywords are free text; speech routes refuse control characters in direction.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .slice(0, MAX_VOICE_DIRECTION_CHARS)
  );
}

/**
 * The voice-over spoken in [fromMs, toMs) as one line per beat, from the burned captions: each line holds
 * the captions of its beat and starts where they start, with direction for its part (the first line is the
 * hook) and the brand's tone of voice. Throws VALIDATION, before anything is paid, when a line has more
 * words than its room holds at `VO_WORDS_PER_SECOND`. Pure: the same IR gives the same lines.
 */
export function voiceLines(ir: VideoIR, fromMs = 0, toMs = ir.format.durationMs): VoiceLine[] {
  const cues = (ir.captions?.cues ?? [])
    .filter((c) => c.startMs >= fromMs && c.endMs <= toMs)
    .sort((a, b) => a.startMs - b.startMs);
  const beats = beatSpans(ir);
  const groups: (typeof cues)[] = [];
  let current = -1;
  for (const cue of cues) {
    const mid = (cue.startMs + cue.endMs) / 2;
    const beat = beats.findIndex((b) => mid >= b.startMs && mid < b.endMs);
    if (beat !== current || groups.length === 0) groups.push([]);
    current = beat;
    groups.at(-1)?.push(cue);
  }
  return groups.map((group, i) => {
    const first = group[0] as (typeof cues)[number];
    const last = group.at(-1) as (typeof cues)[number];
    const roomMs = last.endMs - first.startMs;
    const text = group.map((c) => c.text).join(" ");
    const at = partAt(ir, (first.startMs + last.endMs) / 2);
    const part = i === 0 && at === "message" ? "hook" : at;
    const words = spokenLength(text, ir.language);
    // Compared in whole milliseconds against what the voice stage can still lay (a take sped up to
    // `MAX_VOICE_SPEEDUP`), so a line that just fills its room is never refused by float rounding.
    const mostMs = Math.floor(roomMs * MAX_VOICE_SPEEDUP);
    if (spokenMs(text, ir.language) > mostMs) {
      // The spoken length that still passes, in tenths of a word like `spokenLength`.
      const most = Math.floor((mostMs * VO_WORDS_PER_SECOND) / 100) / 10;
      throw new StudixError("VALIDATION", `Voice-over line "${text.slice(0, 60)}" does not fit its beat`, {
        retryable: false,
        details: { startMs: first.startMs, roomMs, words, mostWords: most },
        suggestedAction: `Cut the line to at most ${most} words (an English word or brand name counts by its syllables), or lengthen its beat.`,
      });
    }
    return {
      text,
      startMs: first.startMs,
      roomMs,
      part,
      instructions: direction(ir, part, i, groups.length, roomMs),
    };
  });
}

/** Where the speech of a take starts and ends, in milliseconds from the start of its file. */
export interface SpokenSpan {
  startMs: number;
  endMs: number;
}

/** Silence kept before the first word of a trimmed take, so the read does not open on a hard edge. */
export const VOICE_LEAD_PAD_MS = 60;

/** How a take fits its line's room: where it is read from, how much of it must be heard, and how fast. */
interface TakeFit {
  trimStartMs: number;
  /** Length of the file after the trim; undefined when the file's length is unknown. */
  restMs: number | undefined;
  /** What must be heard: the speech after the trim, or (unmeasured) the whole rest of the file. */
  spokenMs: number | undefined;
  rate: number;
}

/**
 * Fit a take of `lengthMs` into `line`'s room. With a measured `span`, the leading silence is skipped (but
 * `VOICE_LEAD_PAD_MS`) and only the speech must fit; without one the whole file counts, less a breath of
 * trailing silence (`VOICE_OVERRUN_TOLERANCE_MS`). Undefined when it needs more than `MAX_VOICE_SPEEDUP`.
 */
function fitTake(line: VoiceLine, lengthMs: number | undefined, span?: SpokenSpan): TakeFit | undefined {
  const trimStartMs = span ? Math.max(0, span.startMs - VOICE_LEAD_PAD_MS) : 0;
  const restMs = lengthMs === undefined ? undefined : Math.max(0, lengthMs - trimStartMs);
  const spokenMs = span ? span.endMs - trimStartMs : restMs;
  const tolerance = span ? 0 : VOICE_OVERRUN_TOLERANCE_MS;
  if (spokenMs === undefined || spokenMs <= line.roomMs + tolerance) {
    return { trimStartMs, restMs, spokenMs, rate: 1 };
  }
  const rate = spokenMs / line.roomMs;
  return rate > MAX_VOICE_SPEEDUP ? undefined : { trimStartMs, restMs, spokenMs, rate };
}

/** Whether a take of `lengthMs` (its speech in `span`, when measured) can be laid in `line`'s room. */
export function voiceTakeFits(line: VoiceLine, lengthMs: number | undefined, span?: SpokenSpan): boolean {
  return fitTake(line, lengthMs, span) !== undefined;
}

/** The VALIDATION failure of a line whose take is too long to speed up into its beat. */
export function voiceOverrunError(line: VoiceLine, details: Record<string, unknown>): StudixError {
  return new StudixError("VALIDATION", `Voice-over line "${line.text.slice(0, 60)}" runs past its beat`, {
    retryable: false,
    details: { ...details, roomMs: line.roomMs },
    suggestedAction: "Shorten the line or lengthen its beat, then render again.",
  });
}

/**
 * The track of one generated line, at its beat. With the take's measured speech `span`, the leading
 * silence is trimmed and only the speech is judged. A take that fits plays as is, cut with a short fade at
 * the end of its room (trailing silence); a longer one is sped up to fit, up to `MAX_VOICE_SPEEDUP`; past
 * that it fails VALIDATION rather than spilling into the next beat.
 */
export function voiceLineTrack(line: VoiceLine, asset: AssetRef, id: string, span?: SpokenSpan): AudioTrack {
  const fit = fitTake(line, asset.durationMs, span);
  if (!fit) {
    throw voiceOverrunError(line, {
      assetId: asset.id,
      durationMs: asset.durationMs,
      ...(span ? { speechStartMs: span.startMs, speechEndMs: span.endMs } : {}),
    });
  }
  const base = {
    id,
    kind: "voiceover" as const,
    assetId: asset.id,
    startMs: line.startMs,
    volume: 1,
    ...(fit.trimStartMs > 0 ? { trimStartMs: fit.trimStartMs } : {}),
  };
  if (fit.rate > 1) {
    // Slightly long: read a little faster so the whole line lands inside its beat.
    return {
      ...base,
      durationMs: line.roomMs,
      playbackRate: Math.ceil(fit.rate * 1000) / 1000,
      // A probe a few ms longer than the provider's figure would end the read on a hard cut.
      fadeOutMs: SPEDUP_FADE_MS,
    };
  }
  const cut = fit.restMs !== undefined && fit.restMs > line.roomMs;
  // A measured take is cut in its trailing silence, so its fade stays clear of the last word.
  const fadeOutMs =
    span && fit.spokenMs !== undefined
      ? Math.min(OVERRUN_FADE_MS, Math.max(SPEDUP_FADE_MS, line.roomMs - fit.spokenMs))
      : Math.min(OVERRUN_FADE_MS, line.roomMs);
  return {
    ...base,
    durationMs: Math.max(1, Math.min(line.roomMs, fit.restMs ?? line.roomMs)),
    ...(cut ? { fadeOutMs } : {}),
  };
}

/**
 * `ir` with its voice-over replaced: every voice-over track goes, with the assets only those tracks used,
 * and the new tracks lead the mix. The voice stage owns all voice-over in the IR.
 */
export function withVoiceover(ir: VideoIR, tracks: AudioTrack[], assets: AssetRef[]): VideoIR {
  const kept = (ir.audio ?? []).filter((t) => t.kind !== "voiceover");
  const dropped = new Set((ir.audio ?? []).filter((t) => t.kind === "voiceover").map((t) => t.assetId));
  for (const t of kept) dropped.delete(t.assetId);
  const added = new Set(assets.map((a) => a.id));
  return {
    ...ir,
    assets: [...ir.assets.filter((a) => !dropped.has(a.id) && !added.has(a.id)), ...assets],
    audio: [...tracks, ...kept],
  };
}
