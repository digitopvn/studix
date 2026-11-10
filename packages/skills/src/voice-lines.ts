import { StudixError } from "@studix/shared";
import { type AssetRef, type AudioTrack, resolveSceneSpans, type VideoIR } from "@studix/video-ir";
import { wordCount } from "./caption-chunks.ts";
import { VO_WORDS_PER_SECOND } from "./marketing-video/marketing-script.ts";

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
 * beat, so the stage fails instead.
 */
export const VOICE_OVERRUN_TOLERANCE_MS = 250;
/**
 * Most a take is sped up (pitch kept) to fit its room when it runs past the tolerance: about 12% stays a
 * natural read. A longer take is too long a line, and the stage fails.
 */
export const MAX_VOICE_SPEEDUP = 1.12;
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
    const most = Math.floor((roomMs / 1000) * VO_WORDS_PER_SECOND);
    if (wordCount(text) > most) {
      throw new StudixError("VALIDATION", `Voice-over line "${text.slice(0, 60)}" does not fit its beat`, {
        retryable: false,
        details: { startMs: first.startMs, roomMs, words: wordCount(text), mostWords: most },
        suggestedAction: `Cut the line to at most ${most} words, or lengthen its beat.`,
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

/**
 * The track of one generated line, at its beat. A take up to `VOICE_OVERRUN_TOLERANCE_MS` long
 * (trailing silence) is cut with a short fade; a longer one is sped up to fit, up to `MAX_VOICE_SPEEDUP`;
 * past that it fails VALIDATION rather than spilling into the next beat.
 */
export function voiceLineTrack(line: VoiceLine, asset: AssetRef, id: string): AudioTrack {
  const length = asset.durationMs;
  if (length !== undefined && length > line.roomMs + VOICE_OVERRUN_TOLERANCE_MS) {
    const rate = length / line.roomMs;
    if (rate > MAX_VOICE_SPEEDUP) {
      throw new StudixError("VALIDATION", `Voice-over line "${line.text.slice(0, 60)}" runs past its beat`, {
        retryable: false,
        details: { assetId: asset.id, durationMs: length, roomMs: line.roomMs },
        suggestedAction: "Shorten the line or lengthen its beat, then render again.",
      });
    }
    // Slightly long: read a little faster so the whole line lands inside its beat.
    return {
      id,
      kind: "voiceover",
      assetId: asset.id,
      startMs: line.startMs,
      durationMs: line.roomMs,
      volume: 1,
      playbackRate: Math.ceil(rate * 1000) / 1000,
      // A probe a few ms longer than the provider's figure would end the read on a hard cut.
      fadeOutMs: SPEDUP_FADE_MS,
    };
  }
  const cut = length !== undefined && length > line.roomMs;
  return {
    id,
    kind: "voiceover",
    assetId: asset.id,
    startMs: line.startMs,
    durationMs: Math.max(1, Math.min(line.roomMs, length ?? line.roomMs)),
    volume: 1,
    ...(cut ? { fadeOutMs: Math.min(OVERRUN_FADE_MS, line.roomMs) } : {}),
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
