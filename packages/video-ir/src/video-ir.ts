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
  audio: z.array(AudioTrack).max(16).optional(),
  captions: Captions.optional(),
  /** Free-form, non-semantic metadata (template id, planner info). Renderers must ignore it. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type VideoIR = z.infer<typeof VideoIR>;
