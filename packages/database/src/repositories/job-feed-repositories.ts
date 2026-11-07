import type { ActorRef, JobStatus, TenantContext } from "@studix/core";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { jobs } from "../schema/jobs.ts";
import { workspaceWebhooks } from "../schema/workspace-webhooks.ts";

/** One job row as the change feed sees it: across tenants, only what a notification needs. */
export interface JobChange {
  id: string;
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  status: JobStatus;
  stage: string | null;
  progress: number;
  updatedAt: Date;
}

/**
 * Cross-tenant read of recently changed jobs, for the API's change feed (MCP resource notifications and
 * webhooks). It never returns job content, only ids and status.
 */
export interface JobChangeRepository {
  listChangedSince(since: Date, limit: number): Promise<JobChange[]>;
}

export function createJobChangeRepository(db: StudixDb): JobChangeRepository {
  return {
    async listChangedSince(since, limit) {
      const rows = await db
        .select({
          id: jobs.id,
          workspaceId: jobs.workspaceId,
          organizationId: jobs.organizationId,
          projectId: jobs.projectId,
          status: jobs.status,
          stage: jobs.stage,
          progress: jobs.progress,
          updatedAt: jobs.updatedAt,
        })
        .from(jobs)
        .where(gt(jobs.updatedAt, since))
        .orderBy(asc(jobs.updatedAt))
        .limit(limit);
      return rows.map((r) => ({ ...r, projectId: r.projectId ?? null, stage: r.stage ?? null }));
    },
  };
}

export interface WorkspaceWebhookRecord {
  workspaceId: string;
  url: string;
  secretCiphertext: string;
  secretHint: string;
  updatedAt: Date;
  updatedBy?: ActorRef;
}

export interface WorkspaceWebhookRepository {
  get(ctx: TenantContext): Promise<WorkspaceWebhookRecord | undefined>;
  put(
    ctx: TenantContext,
    input: Pick<WorkspaceWebhookRecord, "url" | "secretCiphertext" | "secretHint">,
    by: ActorRef,
  ): Promise<WorkspaceWebhookRecord>;
  remove(ctx: TenantContext): Promise<boolean>;
  /** Webhooks of these workspaces, for delivery (cross-tenant, by workspace id). */
  listForWorkspaces(workspaceIds: readonly string[]): Promise<WorkspaceWebhookRecord[]>;
}

function toRecord(row: typeof workspaceWebhooks.$inferSelect): WorkspaceWebhookRecord {
  return {
    workspaceId: row.workspaceId,
    url: row.url,
    secretCiphertext: row.secretCiphertext,
    secretHint: row.secretHint,
    updatedAt: row.updatedAt,
    ...(row.updatedByType && row.updatedById
      ? { updatedBy: { type: row.updatedByType, id: row.updatedById } as ActorRef }
      : {}),
  };
}

export function createWorkspaceWebhookRepository(db: StudixDb): WorkspaceWebhookRepository {
  const scope = (ctx: TenantContext) =>
    and(
      eq(workspaceWebhooks.workspaceId, ctx.workspaceId),
      eq(workspaceWebhooks.organizationId, ctx.organizationId),
    );
  return {
    async get(ctx) {
      const rows = await db.select().from(workspaceWebhooks).where(scope(ctx));
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async put(ctx, input, by) {
      const values = { ...input, updatedByType: by.type, updatedById: by.id, updatedAt: new Date() };
      const rows = await db
        .insert(workspaceWebhooks)
        .values({ ...values, workspaceId: ctx.workspaceId, organizationId: ctx.organizationId })
        .onConflictDoUpdate({ target: workspaceWebhooks.workspaceId, set: values })
        .returning();
      const row = rows[0];
      if (!row || row.organizationId !== ctx.organizationId)
        throw new Error("workspace webhook upsert failed");
      return toRecord(row);
    },
    async remove(ctx) {
      const rows = await db.delete(workspaceWebhooks).where(scope(ctx)).returning();
      return rows.length > 0;
    },
    async listForWorkspaces(workspaceIds) {
      if (workspaceIds.length === 0) return [];
      const rows = await db
        .select()
        .from(workspaceWebhooks)
        .where(inArray(workspaceWebhooks.workspaceId, [...workspaceIds]));
      return rows.map(toRecord);
    },
  };
}
