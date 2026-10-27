import type { RendererSupport } from "@studix/core";
import {
  type RenderSpec,
  RenderSpec as RenderSpecSchema,
  type VideoIR,
  validateVideoIR,
} from "@studix/video-ir";
import { IMAGE_EXTENSIONS } from "./compile-composition.ts";

/**
 * What the HyperFrames renderer can draw in P0: title, text, image, logo and CTA shots, colour or image
 * scene backgrounds, all transitions and burned captions. Video shots, video backgrounds and audio tracks
 * are reported instead of being silently dropped.
 */
export function hyperframesSupport(ir: VideoIR, spec: RenderSpec): RendererSupport {
  const reasons: string[] = [];
  const valid = validateVideoIR(ir);
  if (!valid.ok) {
    for (const issue of valid.issues.slice(0, 10))
      reasons.push(`invalid IR at ${issue.path || "/"}: ${issue.message}`);
    return { supported: false, reasons };
  }
  const specCheck = RenderSpecSchema.safeParse(spec);
  if (!specCheck.success) reasons.push("invalid render spec");

  const assets = new Map(ir.assets.map((a) => [a.id, a]));
  const checkImage = (where: string, assetId: string | undefined) => {
    const asset = assetId ? assets.get(assetId) : undefined;
    if (asset && !IMAGE_EXTENSIONS[asset.mime])
      reasons.push(`${where}: image type ${asset.mime} is not supported`);
  };

  checkImage("brand logo", ir.brand?.logoAssetId);
  for (const scene of ir.scenes) {
    const bg = scene.background?.assetId ? assets.get(scene.background.assetId) : undefined;
    if (bg?.kind === "video") reasons.push(`scene "${scene.id}": video backgrounds are not supported yet`);
    else checkImage(`scene "${scene.id}" background`, scene.background?.assetId);
    for (const shot of scene.shots) {
      const where = `scene "${scene.id}" shot "${shot.id}"`;
      if (shot.type === "video") reasons.push(`${where}: video shots are not supported yet`);
      if (shot.type === "image" || shot.type === "logo") checkImage(where, shot.assetId);
    }
  }
  if (ir.audio && ir.audio.length > 0) reasons.push("audio tracks are not supported yet");
  return { supported: reasons.length === 0, reasons };
}
