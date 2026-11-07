import { basename, extname } from "node:path";
import type { AssetRepository, StorageAdapter, TenantContext } from "@studix/core";
import { sha256File } from "@studix/storage";
import type { StageContext } from "@studix/workflow";

/** Media an agent run leaves in /work/out that becomes a project asset; other files stay on the worker. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

/** The longest an S3 presigned URL may live. */
const PREVIEW_URL_SECONDS = 7 * 24 * 3600;

const kindOf = (contentType: string) =>
  contentType.startsWith("video/") ? "video" : contentType.startsWith("audio/") ? "audio" : "image";

/**
 * Turns each media file of an agent run into an asset of the job's project (one version), for previews and
 * as an input file of a later task.
 */
export function createAgentArtifactStore(deps: {
  storage: Pick<StorageAdapter, "put" | "signedUrl">;
  assets: Pick<AssetRepository, "create" | "addVersion">;
}) {
  return async (ctx: TenantContext, stage: StageContext, hostPath: string) => {
    const name = basename(hostPath);
    const contentType = MEDIA_TYPES[extname(name).slice(1).toLowerCase()];
    if (!contentType) return undefined;
    const { sha256, bytes } = await sha256File(hostPath);
    const createdBy = { type: "system", id: "skill-agent" } as const;
    const asset = await deps.assets.create(ctx, {
      ...(stage.job.projectId ? { projectId: stage.job.projectId } : {}),
      kind: kindOf(contentType),
      mime: contentType,
      name,
      createdBy,
    });
    const storageKey = `assets/${asset.id}/v1/${name}`;
    await deps.storage.put(ctx, storageKey, { filePath: hostPath }, { contentType, sha256 });
    await deps.assets.addVersion(ctx, {
      assetId: asset.id,
      storageKey,
      sha256,
      mime: contentType,
      bytes,
      provenance: { source: "generated", provider: "skill-agent" },
      createdBy,
    });
    const url = await deps.storage.signedUrl(ctx, storageKey, { expiresInSeconds: PREVIEW_URL_SECONDS });
    return { assetId: asset.id, storageKey, url, contentType };
  };
}
