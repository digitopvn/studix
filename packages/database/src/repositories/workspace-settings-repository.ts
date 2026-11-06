import type { ActorRef, TenantContext } from "@studix/core";
import { and, eq } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { workspaceSettings } from "../schema/workspace-settings.ts";

export interface WorkspaceSettingsRecord {
  claudePlanner: boolean;
  claudeSubscription: boolean;
  updatedAt?: Date;
  updatedBy?: ActorRef;
}

export type WorkspaceSettingsPatch = Partial<
  Pick<WorkspaceSettingsRecord, "claudePlanner" | "claudeSubscription">
>;

export interface WorkspaceSettingsRepository {
  /** The workspace's switches; all off when nothing was ever saved. */
  get(ctx: TenantContext): Promise<WorkspaceSettingsRecord>;
  update(ctx: TenantContext, patch: WorkspaceSettingsPatch, by: ActorRef): Promise<WorkspaceSettingsRecord>;
}

const OFF: WorkspaceSettingsRecord = { claudePlanner: false, claudeSubscription: false };

function toRecord(row: typeof workspaceSettings.$inferSelect): WorkspaceSettingsRecord {
  return {
    claudePlanner: row.claudePlanner,
    claudeSubscription: row.claudeSubscription,
    updatedAt: row.updatedAt,
    ...(row.updatedByType && row.updatedById
      ? { updatedBy: { type: row.updatedByType, id: row.updatedById } as ActorRef }
      : {}),
  };
}

export function createWorkspaceSettingsRepository(db: StudixDb): WorkspaceSettingsRepository {
  return {
    async get(ctx) {
      const rows = await db
        .select()
        .from(workspaceSettings)
        .where(
          and(
            eq(workspaceSettings.workspaceId, ctx.workspaceId),
            eq(workspaceSettings.organizationId, ctx.organizationId),
          ),
        );
      return rows[0] ? toRecord(rows[0]) : { ...OFF };
    },
    async update(ctx, patch, by) {
      const values = {
        ...patch,
        updatedByType: by.type,
        updatedById: by.id,
        updatedAt: new Date(),
      };
      const rows = await db
        .insert(workspaceSettings)
        .values({ ...OFF, ...values, workspaceId: ctx.workspaceId, organizationId: ctx.organizationId })
        .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: values })
        .returning();
      const row = rows[0];
      if (!row || row.organizationId !== ctx.organizationId)
        throw new Error("workspace settings upsert failed");
      return toRecord(row);
    },
  };
}
