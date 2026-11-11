import { z } from "zod";
import { AssetRef } from "./asset-ref.ts";
import { AudioTrack, Captions } from "./audio-captions.ts";
import { BrandKit } from "./brand-kit.ts";
import { VideoFormat } from "./format.ts";
import { LanguageTag } from "./primitives.ts";
import { Scene } from "./scene.ts";
import { Timeline } from "./timeline.ts";

/** Current IR schema version. Bump only with a registered migration (see migrations.ts). */
export const VIDEO_IR_SCHEMA_VERSION = 1 as const;

/**
 * Audio tracks one VideoIR carries. A 60 s motion graphic already needs a voice line, a whoosh and an
 * accent per beat plus the music bed, so the cap leaves room for that and stays bounded for renderers.
 */
export const MAX_AUDIO_TRACKS = 64;

/**
 * Renderer-neutral video intermediate representation. A stored IR is immutable: edits produce a new
 * project version via applyPatch. Binaries are referenced through `assets`, never embedded.
 */
export const VideoIR = z.object({
  schemaVersion: z.literal(VIDEO_IR_SCHEMA_VERSION),
  title: z.string().min(1).max(200),
  language: LanguageTag,
  format: VideoFormat,
  brand: BrandKit.optional(),
  assets: z.array(AssetRef).max(200),
  scenes: z.array(Scene).min(1).max(100),
  timeline: Timeline,
  audio: z.array(AudioTrack).max(MAX_AUDIO_TRACKS).optional(),
  captions: Captions.optional(),
  /** Free-form, non-semantic metadata (template id, planner info). Renderers must ignore it. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type VideoIR = z.infer<typeof VideoIR>;
