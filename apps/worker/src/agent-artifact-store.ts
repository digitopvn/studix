import { basename, extname } from "node:path";
import type { StorageAdapter, TenantContext } from "@studix/core";
import type { StageContext } from "@studix/workflow";

/** Media an agent run leaves in /work/out that the dashboard previews; other files stay on the worker. */
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

/** Stores the media files of an agent run under the job, for previews and as input files of later tasks. */
export function createAgentArtifactStore(storage: Pick<StorageAdapter, "put" | "signedUrl">) {
  return async (ctx: TenantContext, stage: StageContext, hostPath: string) => {
    const name = basename(hostPath);
    const contentType = MEDIA_TYPES[extname(name).slice(1).toLowerCase()];
    if (!contentType) return undefined;
    const storageKey = `agent-output/${stage.job.id}/attempt-${stage.attempt}/${name}`;
    await storage.put(ctx, storageKey, { filePath: hostPath }, { contentType });
    const url = await storage.signedUrl(ctx, storageKey, { expiresInSeconds: PREVIEW_URL_SECONDS });
    return { storageKey, url, contentType };
  };
}
