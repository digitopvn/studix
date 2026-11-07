import type { ActorRef, TenantContext } from "@studix/core";
import { and, eq } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { workspaceMultixSettings } from "../schema/workspace-multix-settings.ts";

/** What a workspace overrides; null (or a missing role) means the server's MULTIX_* value. */
export interface WorkspaceMultixSettingsValues {
  enabled: boolean | null;
  waitTimeoutSeconds: number | null;
  models: Record<string, string>;
  voiceLanguageModels: string | null;
}

export interface WorkspaceMultixSettingsRecord extends WorkspaceMultixSettingsValues {
  updatedAt?: Date;
  updatedBy?: ActorRef;
}

export interface WorkspaceMultixSettingsRepository {
  /** The workspace's saved settings; undefined when it never saved any. */
  get(ctx: TenantContext): Promise<WorkspaceMultixSettingsRecord | undefined>;
  /** Replace every value of the workspace's row. */
  put(
    ctx: TenantContext,
    values: WorkspaceMultixSettingsValues,
    by: ActorRef,
  ): Promise<WorkspaceMultixSettingsRecord>;
}

function toRecord(row: typeof workspaceMultixSettings.$inferSelect): WorkspaceMultixSettingsRecord {
  return {
    enabled: row.enabled,
    waitTimeoutSeconds: row.waitTimeoutSeconds,
    models: row.models,
    voiceLanguageModels: row.voiceLanguageModels,
    updatedAt: row.updatedAt,
    ...(row.updatedByType && row.updatedById
      ? { updatedBy: { type: row.updatedByType, id: row.updatedById } as ActorRef }
      : {}),
  };
}

export function createWorkspaceMultixSettingsRepository(db: StudixDb): WorkspaceMultixSettingsRepository {
  return {
    async get(ctx) {
      const rows = await db
        .select()
        .from(workspaceMultixSettings)
        .where(
          and(
            eq(workspaceMultixSettings.workspaceId, ctx.workspaceId),
            eq(workspaceMultixSettings.organizationId, ctx.organizationId),
          ),
        );
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async put(ctx, values, by) {
      const set = { ...values, updatedByType: by.type, updatedById: by.id, updatedAt: new Date() };
      const rows = await db
        .insert(workspaceMultixSettings)
        .values({ ...set, workspaceId: ctx.workspaceId, organizationId: ctx.organizationId })
        .onConflictDoUpdate({ target: workspaceMultixSettings.workspaceId, set })
        .returning();
      const row = rows[0];
      if (!row || row.organizationId !== ctx.organizationId)
        throw new Error("workspace multix settings upsert failed");
      return toRecord(row);
    },
  };
}
