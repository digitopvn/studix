import type { ProjectRepository, ProjectVersion, VideoProject } from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { desc, eq, max } from "drizzle-orm";
import type { DbExecutor } from "../client.ts";
import { projectVersions, videoProjects } from "../schema/projects.ts";
import { actorFrom, beforeCursor, first, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";

type ProjectRow = typeof videoProjects.$inferSelect;
type VersionRow = typeof projectVersions.$inferSelect;

function toProject(row: ProjectRow): VideoProject {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    brief: row.brief,
    workflowTemplate: opt(row.workflowTemplate),
    currentVersionId: opt(row.currentVersionId),
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: VersionRow): ProjectVersion {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    version: row.version,
    ir: row.ir,
    source: row.source,
    parentVersionId: opt(row.parentVersionId),
    patch: opt(row.patch),
    idempotencyKey: opt(row.idempotencyKey),
    feedbackId: opt(row.feedbackId),
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
  };
}

export function createProjectRepository(db: DbExecutor, clock: Clock): ProjectRepository {
  return {
    async create(ctx, input) {
      const now = clock.now();
      const rows = await db
        .insert(videoProjects)
        .values({
          id: input.id ?? newId("prj"),
          ...tenantValues(ctx),
          title: input.title,
          status: input.status,
          brief: input.brief,
          workflowTemplate: input.workflowTemplate ?? null,
          currentVersionId: input.currentVersionId ?? null,
          createdByType: input.createdBy.type,
          createdById: input.createdBy.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toProject(first(rows, "project"));
    },

    async get(ctx, id) {
      const rows = await db
        .select()
        .from(videoProjects)
        .where(scoped(videoProjects, ctx, eq(videoProjects.id, id)));
      return rows[0] ? toProject(rows[0]) : undefined;
    },

    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(videoProjects)
        .where(
          scoped(
            videoProjects,
            ctx,
            beforeCursor(videoProjects.id, query.cursor),
            query.status ? eq(videoProjects.status, query.status) : undefined,
          ),
        )
        .orderBy(desc(videoProjects.id))
        .limit(limit + 1);
      return toPage(rows.map(toProject), limit);
    },

    async update(ctx, id, patch) {
      const rows = await db
        .update(videoProjects)
        .set({ ...patch, updatedAt: clock.now() })
        .where(scoped(videoProjects, ctx, eq(videoProjects.id, id)))
        .returning();
      return toProject(first(rows, `project ${id}`));
    },

    async delete(ctx, id) {
      const rows = await db
        .delete(videoProjects)
        .where(scoped(videoProjects, ctx, eq(videoProjects.id, id)))
        .returning({ id: videoProjects.id });
      return rows.length > 0;
    },

    async createVersion(ctx, input) {
      return db.transaction(async (tx) => {
        // Lock the project row so concurrent versions get distinct numbers (and prove tenancy).
        const locked = await tx
          .select({ id: videoProjects.id, currentVersionId: videoProjects.currentVersionId })
          .from(videoProjects)
          .where(scoped(videoProjects, ctx, eq(videoProjects.id, input.projectId)))
          .for("update");
        if (locked.length === 0) throw new StudixError("NOT_FOUND", `project ${input.projectId} not found`);
        // Same key under the same lock: converge on the version the first request stored.
        if (input.idempotencyKey !== undefined) {
          const [same] = await tx
            .select()
            .from(projectVersions)
            .where(
              scoped(
                projectVersions,
                ctx,
                eq(projectVersions.projectId, input.projectId),
                eq(projectVersions.idempotencyKey, input.idempotencyKey),
              ),
            );
          if (same) return toVersion(same);
        }
        // Compare-and-set under the row lock: of two writers on the same base, only the first one wins.
        if (input.advanceFrom !== undefined && locked[0]?.currentVersionId !== input.advanceFrom) {
          throw new StudixError("CONFLICT", `version ${input.advanceFrom} is no longer current`, {
            details: { currentVersionId: locked[0]?.currentVersionId ?? null },
          });
        }
        const [current] = await tx
          .select({ version: max(projectVersions.version) })
          .from(projectVersions)
          .where(scoped(projectVersions, ctx, eq(projectVersions.projectId, input.projectId)));
        const rows = await tx
          .insert(projectVersions)
          .values({
            id: input.id ?? newId("pver"),
            ...tenantValues(ctx),
            projectId: input.projectId,
            version: (current?.version ?? 0) + 1,
            schemaVersion: input.ir.schemaVersion,
            ir: input.ir,
            source: input.source,
            parentVersionId: input.parentVersionId ?? null,
            patch: input.patch ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            feedbackId: input.feedbackId ?? null,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: clock.now(),
          })
          .returning();
        const created = first(rows, "project version");
        if (input.advanceFrom !== undefined) {
          await tx
            .update(videoProjects)
            .set({ currentVersionId: created.id, updatedAt: clock.now() })
            .where(scoped(videoProjects, ctx, eq(videoProjects.id, input.projectId)));
        }
        return toVersion(created);
      });
    },

    async findVersionByIdempotencyKey(ctx, projectId, idempotencyKey) {
      const rows = await db
        .select()
        .from(projectVersions)
        .where(
          scoped(
            projectVersions,
            ctx,
            eq(projectVersions.projectId, projectId),
            eq(projectVersions.idempotencyKey, idempotencyKey),
          ),
        );
      return rows[0] ? toVersion(rows[0]) : undefined;
    },

    async getVersion(ctx, versionId) {
      const rows = await db
        .select()
        .from(projectVersions)
        .where(scoped(projectVersions, ctx, eq(projectVersions.id, versionId)));
      return rows[0] ? toVersion(rows[0]) : undefined;
    },

    async listVersions(ctx, projectId, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(projectVersions)
        .where(
          scoped(
            projectVersions,
            ctx,
            eq(projectVersions.projectId, projectId),
            beforeCursor(projectVersions.id, query.cursor),
          ),
        )
        .orderBy(desc(projectVersions.id))
        .limit(limit + 1);
      return toPage(rows.map(toVersion), limit);
    },
  };
}
