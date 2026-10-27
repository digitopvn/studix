import type { JobView, Render, RenderRepository, TenantContext } from "@studix/core";
import { type Logger, StudixError } from "@studix/shared";
import type { ArtifactUrlSigner } from "./ports.ts";

/** A signed, short-lived playback/download URL for a rendered MP4. */
export interface PlaybackUrl {
  renderId: string;
  url: string;
  expiresAt: string;
  preset: Render["preset"];
}

export interface ArtifactUrlDeps {
  renders: RenderRepository;
  storage?: ArtifactUrlSigner;
  ttlSeconds: number;
  clock?: () => Date;
  logger?: Logger;
}

/** True when the render has a stored MP4 that can be signed. */
export function isPlayable(render: Render): render is Render & { storageKey: string } {
  return render.status === "succeeded" && typeof render.storageKey === "string" && render.storageKey !== "";
}

/**
 * Sign a URL for a render the caller already read through a tenant-scoped repository. Signing happens only
 * after that scoped read, so a foreign render id can never yield a URL.
 */
export async function signRender(
  deps: ArtifactUrlDeps,
  ctx: TenantContext,
  render: Render,
): Promise<PlaybackUrl | undefined> {
  if (!isPlayable(render) || !deps.storage) return undefined;
  const url = await deps.storage.signedUrl(ctx, render.storageKey, { expiresInSeconds: deps.ttlSeconds });
  const now = deps.clock?.() ?? new Date();
  return {
    renderId: render.id,
    url,
    expiresAt: new Date(now.getTime() + deps.ttlSeconds * 1000).toISOString(),
    preset: render.preset,
  };
}

/** Signed URL for a render by id (dashboard playback). NOT_FOUND for foreign or missing renders. */
export async function playbackForRender(
  deps: ArtifactUrlDeps,
  ctx: TenantContext,
  renderId: string,
): Promise<PlaybackUrl> {
  const render = await deps.renders.get(ctx, renderId);
  if (!render) throw new StudixError("NOT_FOUND", `render ${renderId} not found`);
  if (!isPlayable(render)) {
    throw new StudixError("CONFLICT", "Render has no playable output yet", {
      details: { status: render.status },
      suggestedAction: "Wait for the render to succeed, then request the URL again.",
    });
  }
  if (!deps.storage) {
    throw new StudixError("UNAVAILABLE", "Artifact storage is not configured on this server");
  }
  return (await signRender(deps, ctx, render))!;
}

/**
 * Signed MP4 URL for a finished job: the newest succeeded render produced by this job, falling back to the
 * render id the worker recorded in `job.result.renderId`. Undefined while the job is not finished or when
 * storage is not configured (callers report that, they do not fail).
 */
export async function playbackForJob(
  deps: ArtifactUrlDeps,
  ctx: TenantContext,
  job: JobView,
): Promise<PlaybackUrl | undefined> {
  if (job.status !== "succeeded" || !job.projectId) return undefined;
  const renders = await deps.renders.listByProject(ctx, job.projectId, { limit: 20 });
  const resultRenderId = typeof job.result?.renderId === "string" ? job.result.renderId : undefined;
  const render =
    renders.items.find((r) => r.jobId === job.id && isPlayable(r)) ??
    (resultRenderId ? renders.items.find((r) => r.id === resultRenderId && isPlayable(r)) : undefined);
  if (!render) return undefined;
  try {
    return await signRender(deps, ctx, render);
  } catch (error) {
    deps.logger?.warn("artifact signing failed", {
      renderId: render.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
