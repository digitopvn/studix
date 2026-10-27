import { z } from "zod";
import { IrId, LanguageTag, Milliseconds, PositiveMilliseconds } from "./primitives.ts";

export const AudioTrack = z.object({
  id: IrId,
  kind: z.enum(["music", "voiceover", "sfx"]),
  /** Audio asset id from the IR `assets` list. */
  assetId: IrId,
  startMs: Milliseconds,
  /** Defaults to the remaining video duration. */
  durationMs: PositiveMilliseconds.optional(),
  /** Offset into the source audio. */
  trimStartMs: Milliseconds.optional(),
  volume: z.number().min(0).max(1),
  fadeInMs: z.number().int().min(0).max(10_000).optional(),
  fadeOutMs: z.number().int().min(0).max(10_000).optional(),
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
