import { z } from "zod";
import { IrId, LanguageTag, Milliseconds, PositiveMilliseconds } from "./primitives.ts";

/**
 * Mix bus of a track. `dialogue` is on-screen speech (lip-synced to a character), `voiceover` is
 * off-screen narration; renderers may duck music under both.
 */
export const AudioTrackKind = z.enum(["dialogue", "voiceover", "music", "sfx"]);
export type AudioTrackKind = z.infer<typeof AudioTrackKind>;

/**
 * One clip on the multi-track mix. Every track is placed on the absolute timeline; tracks of any kind may
 * overlap. Effective level = `volume` (linear 0..1) scaled by `gainDb` (default 0 dB), with linear fades.
 */
export const AudioTrack = z.object({
  id: IrId,
  kind: AudioTrackKind,
  /** Audio asset id from the IR `assets` list. */
  assetId: IrId,
  startMs: Milliseconds,
  /** Defaults to the remaining video duration. */
  durationMs: PositiveMilliseconds.optional(),
  /** Offset into the source audio. */
  trimStartMs: Milliseconds.optional(),
  volume: z.number().min(0).max(1),
  /** Extra gain in dB applied after `volume` (e.g. -6 to sit SFX under dialogue). */
  gainDb: z.number().min(-60).max(12).optional(),
  fadeInMs: z.number().int().min(0).max(10_000).optional(),
  fadeOutMs: z.number().int().min(0).max(10_000).optional(),
  /**
   * Plays the source this much faster (pitch kept): `durationMs` stays timeline time and the track reads
   * `durationMs × playbackRate` of its source. Lets a slightly long voice-over take fit its beat.
   */
  playbackRate: z.number().min(0.5).max(2).optional(),
  /**
   * Music only: lowers the track by this many dB while any voiceover or dialogue track plays, ramped down
   * shortly before the speech and back up after it, so the words sit clearly over the bed (e.g. -12).
   * Other kinds ignore it.
   */
  duckDb: z.number().min(-40).max(0).optional(),
});
export type AudioTrack = z.infer<typeof AudioTrack>;

export const CaptionCue = z
  .object({
    startMs: Milliseconds,
    endMs: PositiveMilliseconds,
    text: z.string().min(1).max(300),
  })
  .refine((cue) => cue.endMs > cue.startMs, { message: "endMs must be after startMs", path: ["endMs"] });
export type CaptionCue = z.infer<typeof CaptionCue>;

export const Captions = z.object({
  language: LanguageTag,
  /** Burned into the frame (open) or delivered as a sidecar track (closed). */
  mode: z.enum(["burned", "sidecar"]),
  position: z.enum(["top", "middle", "bottom"]).optional(),
  cues: z.array(CaptionCue).min(1).max(2000),
});
export type Captions = z.infer<typeof Captions>;
