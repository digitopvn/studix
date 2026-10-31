import type {
  AgentRuntimeName,
  ModelChoice,
  ModelPreference,
  PreferenceScope,
  ResolvedModelSnapshot,
  TenantContext,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { desc, eq, or } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { jobs } from "../schema/jobs.ts";
import { jobModelSnapshots, modelPreferences } from "../schema/provider-connections.ts";
import { first, scoped, tenantValues } from "./helpers.ts";

export interface UpsertModelPreferenceInput extends ModelChoice {
  scope: PreferenceScope;
  stage: string;
  runtime: AgentRuntimeName;
  allowFallback: boolean;
  fallbacks: ModelChoice[];
}

/**
 * Storage only: who may write which scope, and whether the connections are usable, is decided by the
 * model preference service in @studix/auth before it calls this.
 */
export interface ModelPreferenceRepository {
  /** Insert or replace the entry for (scope, stage, runtime). */
  upsert(ctx: TenantContext, input: UpsertModelPreferenceInput): Promise<ModelPreference>;
  get(ctx: TenantContext, id: string): Promise<ModelPreference | undefined>;
  /** Workspace entries plus, when `userId` is given, that member's personal entries. */
  list(
    ctx: TenantContext,
    query?: { userId?: string; runtime?: AgentRuntimeName },
  ): Promise<ModelPreference[]>;
  delete(ctx: TenantContext, id: string): Promise<void>;
}

export interface ModelSnapshotRepository {
  /**
   * Store the snapshot unless one exists for (job, runtime, stage); returns whichever is stored, so the
   * first writer wins when two attempts race.
   */
  pin(ctx: TenantContext, jobId: string, snapshot: ResolvedModelSnapshot): Promise<ResolvedModelSnapshot>;
  get(
    ctx: TenantContext,
    jobId: string,
    key: { runtime: AgentRuntimeName; stage: string },
  ): Promise<ResolvedModelSnapshot | undefined>;
}

/** Upper bound on preferences returned by `list`: a few stages per runtime, per member. */
const MAX_LIST = 500;

function toPreference(row: typeof modelPreferences.$inferSelect): ModelPreference {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    scope: row.scopeUserId === "" ? { type: "workspace" } : { type: "user", userId: row.scopeUserId },
    stage: row.stage,
    runtime: row.runtime,
    connectionId: row.connectionId,
    provider: row.provider,
    modelId: row.modelId,
    allowFallback: row.allowFallback,
    fallbacks: row.fallbacks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createModelPreferenceRepository(db: StudixDb, clock: Clock): ModelPreferenceRepository {
  return {
    async upsert(ctx, input) {
      const now = clock.now();
      const scopeUserId = input.scope.type === "user" ? input.scope.userId : "";
      if (input.scope.type === "user" && scopeUserId === "") {
        throw new StudixError("VALIDATION", "A personal preference needs a user id");
      }
      const choice = {
        connectionId: input.connectionId,
        provider: input.provider,
        modelId: input.modelId,
        allowFallback: input.allowFallback,
        fallbacks: input.fallbacks,
      };
      const rows = await db
        .insert(modelPreferences)
        .values({
          id: newId("mpref"),
          ...tenantValues(ctx),
          scopeUserId,
          stage: input.stage,
          runtime: input.runtime,
          ...choice,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            modelPreferences.workspaceId,
            modelPreferences.scopeUserId,
            modelPreferences.stage,
            modelPreferences.runtime,
          ],
          set: { ...choice, updatedAt: now },
        })
        .returning();
      return toPreference(first(rows, "model preference"));
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(modelPreferences)
        .where(scoped(modelPreferences, ctx, eq(modelPreferences.id, id)));
      return rows[0] ? toPreference(rows[0]) : undefined;
    },
    async list(ctx, query = {}) {
      const visible = query.userId
        ? or(eq(modelPreferences.scopeUserId, ""), eq(modelPreferences.scopeUserId, query.userId))
        : eq(modelPreferences.scopeUserId, "");
      const rows = await db
        .select()
        .from(modelPreferences)
        .where(
          scoped(
            modelPreferences,
            ctx,
            visible,
            query.runtime ? eq(modelPreferences.runtime, query.runtime) : undefined,
          ),
        )
        .orderBy(desc(modelPreferences.id))
        .limit(MAX_LIST);
      return rows.map(toPreference);
    },
    async delete(ctx, id) {
      await db.delete(modelPreferences).where(scoped(modelPreferences, ctx, eq(modelPreferences.id, id)));
    },
  };
}

export function createModelSnapshotRepository(db: StudixDb, clock: Clock): ModelSnapshotRepository {
  const read = async (ctx: TenantContext, jobId: string, runtime: AgentRuntimeName, stage: string) => {
    const rows = await db
      .select({ snapshot: jobModelSnapshots.snapshot })
      .from(jobModelSnapshots)
      .where(
        scoped(
          jobModelSnapshots,
          ctx,
          eq(jobModelSnapshots.jobId, jobId),
          eq(jobModelSnapshots.runtime, runtime),
          eq(jobModelSnapshots.stage, stage),
        ),
      );
    return rows[0]?.snapshot;
  };
  return {
    async pin(ctx, jobId, snapshot) {
      // The job must belong to the caller's tenant; the FK alone would accept another workspace's job id.
      const owned = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(scoped(jobs, ctx, eq(jobs.id, jobId)));
      if (owned.length === 0) throw new StudixError("NOT_FOUND", `Job ${jobId} not found`);
      await db
        .insert(jobModelSnapshots)
        .values({
          ...tenantValues(ctx),
          jobId,
          runtime: snapshot.runtime,
          stage: snapshot.stage,
          snapshot,
          createdAt: clock.now(),
        })
        .onConflictDoNothing();
      return (await read(ctx, jobId, snapshot.runtime, snapshot.stage)) ?? snapshot;
    },
    get(ctx, jobId, key) {
      return read(ctx, jobId, key.runtime, key.stage);
    },
  };
}
