import { z } from "zod";
import { AssetRef } from "./asset-ref.ts";
import { AudioTrack } from "./audio-captions.ts";
import { BrandKit } from "./brand-kit.ts";
import { CreativeBrief } from "./creative-brief.ts";
import { FilmProduction } from "./film-production.ts";
import { VideoIRPatch } from "./patch.ts";
import { RenderSpec } from "./render-spec.ts";
import { Scene } from "./scene.ts";
import { Shot } from "./shot.ts";
import { Storyboard } from "./storyboard.ts";
import { Timeline } from "./timeline.ts";
import { VideoIR } from "./video-ir.ts";

/** Schemas published as JSON Schema (for MCP tool inputs, docs and non-TS clients). */
export const PUBLISHED_SCHEMAS = {
  "video-ir": VideoIR,
  "creative-brief": CreativeBrief,
  "brand-kit": BrandKit,
  scene: Scene,
  shot: Shot,
  timeline: Timeline,
  "asset-ref": AssetRef,
  "render-spec": RenderSpec,
  "video-ir-patch": VideoIRPatch,
  storyboard: Storyboard,
  "audio-track": AudioTrack,
  "film-production": FilmProduction,
} as const;

export type PublishedSchemaName = keyof typeof PUBLISHED_SCHEMAS;

/** JSON Schema (draft 2020-12, input shape) for every published schema, keyed by file-safe name. */
export function exportJsonSchemas(): Record<PublishedSchemaName, Record<string, unknown>> {
  const out = {} as Record<PublishedSchemaName, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(PUBLISHED_SCHEMAS) as [PublishedSchemaName, z.ZodType][]) {
    out[name] = {
      $id: `studix:${name}`,
      ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }),
    };
  }
  return out;
}
