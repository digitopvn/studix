import type { ProjectRepository } from "@studix/core";

type Ctx = Parameters<ProjectRepository["get"]>[0];

/**
 * Mark the project `in_review` once a job finished `versionId`, but only while that version is still the
 * project's head: a retried or stale job for an older version must not overwrite the status of newer work.
 */
export async function markInReviewIfHead(
  repos: { projects: ProjectRepository },
  ctx: Ctx,
  projectId: string,
  versionId: string,
): Promise<void> {
  const project = await repos.projects.get(ctx, projectId);
  if (project?.currentVersionId === versionId)
    await repos.projects.update(ctx, projectId, { status: "in_review" });
}
