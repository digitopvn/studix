import { StudixError } from "@studix/shared";
import { buildSequentialTimeline, type Shot, type VideoIR } from "@studix/video-ir";
import { z } from "zod";

export const VariantSpan = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sceneId: z.string().min(1),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().positive(),
});
export type VariantSpan = z.infer<typeof VariantSpan>;

/** The ads of a marketing-video IR, from `metadata.variants` (written by the template). */
export function irVariants(ir: VideoIR): VariantSpan[] {
  const parsed = z.array(VariantSpan).min(1).safeParse(ir.metadata?.variants);
  if (!parsed.success) {
    throw new StudixError("VALIDATION", "This IR has no marketing-video variants", {
      retryable: false,
      details: { issues: parsed.error.issues.slice(0, 5) },
      suggestedAction: "Create the project with workflowTemplate marketing-video.",
    });
  }
  for (const v of parsed.data) {
    if (!ir.scenes.some((s) => s.id === v.sceneId)) {
      throw new StudixError("VALIDATION", `Variant ${v.id} names a scene the IR does not have`, {
        retryable: false,
        details: { variant: v.id, sceneId: v.sceneId },
      });
    }
  }
  return parsed.data;
}

/**
 * Ads are full-bleed: a frame or clip that names no region fills the whole frame under the copy (its
 * storyboard prompt leaves room above and below for the text). A region the IR names is kept.
 */
function fullBleed(shot: Shot): Shot {
  if ((shot.type !== "image" && shot.type !== "video") || shot.style?.region) return shot;
  return { ...shot, style: { ...shot.style, region: "full" } };
}

/**
 * The standalone IR of one ad: its scene alone, with the audio tracks and caption cues that fall inside
 * the ad moved to start at zero, its pictures full-bleed, and only the assets it uses. Each ad renders and
 * ships as its own file.
 */
export function variantIr(ir: VideoIR, variant: VariantSpan): VideoIR {
  const scene = ir.scenes.find((s) => s.id === variant.sceneId);
  if (!scene) throw new StudixError("INTERNAL", `scene ${variant.sceneId} is missing`, { retryable: false });
  const from = variant.startMs;
  const to = variant.startMs + variant.durationMs;
  const audio = (ir.audio ?? [])
    .filter((t) => t.startMs >= from && t.startMs < to)
    .map((t) => ({
      ...t,
      startMs: t.startMs - from,
      durationMs: Math.min(t.durationMs ?? to - t.startMs, to - t.startMs),
    }));
  const cues = (ir.captions?.cues ?? [])
    .filter((c) => c.startMs >= from && c.endMs <= to)
    .map((c) => ({ ...c, startMs: c.startMs - from, endMs: c.endMs - from }));
  const used = new Set<string>();
  for (const shot of scene.shots) if ("assetId" in shot && shot.assetId) used.add(shot.assetId);
  if (scene.background?.assetId) used.add(scene.background.assetId);
  if (ir.brand?.logoAssetId) used.add(ir.brand.logoAssetId);
  for (const track of audio) used.add(track.assetId);
  const { captions: _captions, audio: _audio, ...rest } = ir;
  return {
    ...rest,
    title: `${ir.title} — ${variant.name}`.slice(0, 200),
    format: { ...ir.format, durationMs: variant.durationMs },
    assets: ir.assets.filter((a) => used.has(a.id)),
    scenes: [{ ...scene, shots: scene.shots.map(fullBleed), durationMs: variant.durationMs }],
    timeline: buildSequentialTimeline([{ id: scene.id, durationMs: variant.durationMs }]),
    ...(audio.length > 0 ? { audio } : {}),
    ...(cues.length > 0 && ir.captions ? { captions: { ...ir.captions, cues } } : {}),
    metadata: { ...ir.metadata, variants: [{ ...variant, startMs: 0 }] },
  };
}
