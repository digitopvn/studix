import type { JobView, ProjectDetails, TenantContext } from "@studix/core";
import {
  type ArtifactUrlDeps,
  isPlayable,
  type PlaybackUrl,
  playbackForJob,
  signRender,
} from "./artifact-urls.ts";

/**
 * Client-facing shapes shared by the MCP tools and the dashboard API, so both surfaces return the same
 * project/job structure. Pure presentation over StudioService results; no pipeline logic.
 */

export interface JobWithVideo extends JobView {
  /** Signed MP4 URL once the job succeeded and storage is configured. */
  video?: PlaybackUrl;
  /** Why `video` is missing for a succeeded job. */
  videoUnavailableReason?: string;
}

export async function jobWithVideo(
  deps: ArtifactUrlDeps,
  ctx: TenantContext,
  job: JobView,
): Promise<JobWithVideo> {
  if (job.status !== "succeeded") return job;
  const video = await playbackForJob(deps, ctx, job);
  if (video) return { ...job, video };
  return {
    ...job,
    videoUnavailableReason: deps.storage
      ? "No playable render recorded for this job."
      : "Artifact storage is not configured on this server.",
  };
}

export async function projectView(
  deps: ArtifactUrlDeps,
  ctx: TenantContext,
  details: ProjectDetails,
  options: { includeIr: boolean },
) {
  const renders = await Promise.all(
    details.renders.map(async (render) => {
      const { spec: _spec, ...rest } = render;
      const playback = isPlayable(render)
        ? await signRender(deps, ctx, render).catch(() => undefined)
        : undefined;
      return { ...rest, ...(playback ? { url: playback.url, urlExpiresAt: playback.expiresAt } : {}) };
    }),
  );
  const version = details.currentVersion;
  return {
    project: details.project,
    currentVersion: version
      ? options.includeIr
        ? version
        : { id: version.id, version: version.version, source: version.source, createdAt: version.createdAt }
      : undefined,
    jobs: details.jobs,
    renders,
  };
}
