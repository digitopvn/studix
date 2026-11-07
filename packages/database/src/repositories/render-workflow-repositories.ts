import type { Render, RenderRepository, WorkflowRun, WorkflowRunRepository } from "@studix/core";
import { type Clock, newId } from "@studix/shared";
import { desc, eq } from "drizzle-orm";
import type { DbExecutor, StudixDb } from "../client.ts";
import { workflowRuns } from "../schema/jobs.ts";
import { renders } from "../schema/projects.ts";
import { actorFrom, beforeCursor, first, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";
import { activeStorageProfileSql } from "./storage-profile-repository.ts";

function toRender(row: typeof renders.$inferSelect): Render {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    versionId: row.versionId,
    jobId: opt(row.jobId),
    preset: row.preset,
    spec: row.spec,
    status: row.status,
    assetVersionId: opt(row.assetVersionId),
    storageKey: opt(row.storageKey),
    probe: opt(row.probe),
    error: opt(row.error),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: opt(row.completedAt),
  };
}

function toRun(row: typeof workflowRuns.$inferSelect): WorkflowRun {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: opt(row.projectId),
    template: row.template,
    status: row.status,
    input: row.input,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: opt(row.finishedAt),
  };
}

export function createRenderRepository(db: DbExecutor, clock: Clock): RenderRepository {
  return {
    async create(ctx, input) {
      const now = clock.now();
      const rows = await db
        .insert(renders)
        .values({
          id: input.id ?? newId("rnd"),
          ...tenantValues(ctx),
          projectId: input.projectId,
          versionId: input.versionId,
          jobId: input.jobId ?? null,
          preset: input.preset,
          spec: input.spec,
          status: input.status,
          assetVersionId: input.assetVersionId ?? null,
          storageKey: input.storageKey ?? null,
          storageProfileId: activeStorageProfileSql,
          probe: input.probe ?? null,
          error: input.error ?? null,
          createdAt: now,
          updatedAt: now,
          completedAt: input.completedAt ?? null,
        })
        .returning();
      return toRender(first(rows, "render"));
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(renders)
        .where(scoped(renders, ctx, eq(renders.id, id)));
      return rows[0] ? toRender(rows[0]) : undefined;
    },
    async update(ctx, id, patch) {
      const rows = await db
        .update(renders)
        .set({
          ...patch,
          // A render's output is uploaded after the row exists: record the profile it went to.
          ...(patch.storageKey ? { storageProfileId: activeStorageProfileSql } : {}),
          updatedAt: clock.now(),
        })
        .where(scoped(renders, ctx, eq(renders.id, id)))
        .returning();
      return toRender(first(rows, `render ${id}`));
    },
    async listByProject(ctx, projectId, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(renders)
        .where(scoped(renders, ctx, eq(renders.projectId, projectId), beforeCursor(renders.id, query.cursor)))
        .orderBy(desc(renders.id))
        .limit(limit + 1);
      return toPage(rows.map(toRender), limit);
    },
  };
}

export function createWorkflowRunRepository(db: StudixDb, clock: Clock): WorkflowRunRepository {
  return {
    async create(ctx, input) {
      const now = clock.now();
      const rows = await db
        .insert(workflowRuns)
        .values({
          id: input.id ?? newId("wfr"),
          ...tenantValues(ctx),
          projectId: input.projectId ?? null,
          template: input.template,
          status: input.status,
          input: input.input,
          createdByType: input.createdBy.type,
          createdById: input.createdBy.id,
          createdAt: now,
          updatedAt: now,
          finishedAt: input.finishedAt ?? null,
        })
        .returning();
      return toRun(first(rows, "workflow run"));
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(workflowRuns)
        .where(scoped(workflowRuns, ctx, eq(workflowRuns.id, id)));
      return rows[0] ? toRun(rows[0]) : undefined;
    },
    async update(ctx, id, patch) {
      const rows = await db
        .update(workflowRuns)
        .set({ ...patch, updatedAt: clock.now() })
        .where(scoped(workflowRuns, ctx, eq(workflowRuns.id, id)))
        .returning();
      return toRun(first(rows, `workflow run ${id}`));
    },
  };
}
