import type { RendererSupport } from "@studix/core";
import {
  type RenderSpec,
  RenderSpec as RenderSpecSchema,
  type VideoIR,
  validateVideoIR,
} from "@studix/video-ir";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./compile-composition.ts";

/**
 * What the HyperFrames renderer can draw: every shot type (video shots play as timed clips), colour, image
 * or video scene backgrounds, all transitions, burned captions, and audio tracks mixed by the FFmpeg
 * finish. Media types the browser or the frame extractor cannot read are reported instead of being
 * silently dropped.
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
  const checkMedia = (where: string, assetId: string | undefined) => {
    const asset = assetId ? assets.get(assetId) : undefined;
    if (!asset) return;
    const known = asset.kind === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
    if (!known[asset.mime]) reasons.push(`${where}: ${asset.kind} type ${asset.mime} is not supported`);
  };

  checkMedia("brand logo", ir.brand?.logoAssetId);
  for (const scene of ir.scenes) {
    checkMedia(`scene "${scene.id}" background`, scene.background?.assetId);
    for (const shot of scene.shots) {
      const where = `scene "${scene.id}" shot "${shot.id}"`;
      if (shot.type === "composition") reasons.push(`${where}: composition shots are not supported yet`);
      if (shot.type === "image" || shot.type === "logo" || shot.type === "video")
        checkMedia(where, shot.assetId);
    }
  }
  for (const track of ir.audio ?? []) {
    const asset = assets.get(track.assetId);
    if (asset && !asset.mime.startsWith("audio/"))
      reasons.push(`audio "${track.id}": type ${asset.mime} is not an audio type`);
  }
  return { supported: reasons.length === 0, reasons };
}
