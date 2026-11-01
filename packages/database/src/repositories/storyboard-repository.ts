import type { ProjectStoryboard, StoryboardRepository } from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { desc, eq } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { projectStoryboards, projectVersions, videoProjects } from "../schema/projects.ts";
import { actorFrom, first, isUniqueViolation, scoped, tenantValues } from "./helpers.ts";

function toStoryboard(row: typeof projectStoryboards.$inferSelect): ProjectStoryboard {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    revision: row.revision,
    versionId: row.versionId,
    storyboard: row.storyboard,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
  };
}

function staleRevision(): StudixError {
  return new StudixError("CONFLICT", "storyboard changed since it was read", {
    suggestedAction: "Reload the storyboard and decide again.",
  });
}

export function createStoryboardRepository(db: StudixDb, clock: Clock): StoryboardRepository {
  const latest = async (
    exec: Pick<StudixDb, "select">,
    ctx: Parameters<StoryboardRepository["latest"]>[0],
    projectId: string,
  ) => {
    const rows = await exec
      .select()
      .from(projectStoryboards)
      .where(scoped(projectStoryboards, ctx, eq(projectStoryboards.projectId, projectId)))
      .orderBy(desc(projectStoryboards.revision))
      .limit(1);
    return rows[0] ? toStoryboard(rows[0]) : undefined;
  };

  return {
    latest: (ctx, projectId) => latest(db, ctx, projectId),

    async append(ctx, input) {
      try {
        return await db.transaction(async (tx) => {
          // The project row lock serializes writers; it also proves the project is in the tenant.
          const locked = await tx
            .select({ id: videoProjects.id })
            .from(videoProjects)
            .where(scoped(videoProjects, ctx, eq(videoProjects.id, input.projectId)))
            .for("update");
          if (locked.length === 0) throw new StudixError("NOT_FOUND", `project ${input.projectId} not found`);
          const [version] = await tx
            .select({ projectId: projectVersions.projectId })
            .from(projectVersions)
            .where(scoped(projectVersions, ctx, eq(projectVersions.id, input.versionId)));
          if (version?.projectId !== input.projectId)
            throw new StudixError("NOT_FOUND", `project version ${input.versionId} not found`);
          const current = await latest(tx, ctx, input.projectId);
          if (input.revision !== (current?.revision ?? 0) + 1) throw staleRevision();
          const rows = await tx
            .insert(projectStoryboards)
            .values({
              id: input.id ?? newId("sbd"),
              ...tenantValues(ctx),
              projectId: input.projectId,
              revision: input.revision,
              versionId: input.versionId,
              storyboard: input.storyboard,
              createdByType: input.createdBy.type,
              createdById: input.createdBy.id,
              createdAt: clock.now(),
            })
            .returning();
          return toStoryboard(first(rows, "storyboard"));
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw staleRevision();
        throw err;
      }
    },
  };
}
