import { type Clock, StudixError } from "@studix/shared";
import type { ProjectStoryboard } from "../entities/storyboard.ts";
import type { ProjectRepository } from "../repositories/project-repository.ts";
import type { StoryboardRepository } from "../repositories/storyboard-repository.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

export function createInMemoryStoryboardRepository(
  clock: Clock,
  projects: Pick<ProjectRepository, "get" | "getVersion">,
): StoryboardRepository {
  const rows = new InMemoryTenantTable<ProjectStoryboard>("sbd", clock, false);
  const latest = (ctx: Parameters<StoryboardRepository["latest"]>[0], projectId: string) =>
    rows.filter(ctx, (r) => r.projectId === projectId).sort((a, b) => b.revision - a.revision)[0];
  return {
    async latest(ctx, projectId) {
      return latest(ctx, projectId);
    },
    async append(ctx, input) {
      if (!(await projects.get(ctx, input.projectId)))
        throw new StudixError("NOT_FOUND", `project ${input.projectId} not found`);
      const version = await projects.getVersion(ctx, input.versionId);
      if (!version || version.projectId !== input.projectId)
        throw new StudixError("NOT_FOUND", `project version ${input.versionId} not found`);
      const expected = (latest(ctx, input.projectId)?.revision ?? 0) + 1;
      if (input.revision !== expected) {
        throw new StudixError("CONFLICT", "storyboard changed since it was read", {
          details: { expectedRevision: expected - 1 },
          suggestedAction: "Reload the storyboard and decide again.",
        });
      }
      return rows.insert(ctx, input);
    },
  };
}
