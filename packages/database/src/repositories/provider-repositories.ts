import type {
  AgentRuntimeId,
  ModelPreference,
  ModelPreferenceRepository,
  ModelSnapshotRepository,
  ProviderConnection,
  ProviderConnectionRepository,
  SealedCredentialStore,
  TenantContext,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { jobs } from "../schema/jobs.ts";
import {
  jobModelSnapshots,
  modelPreferences,
  providerConnections,
  providerCredentials,
} from "../schema/providers.ts";
import { actorFrom, first, isUniqueViolation, scoped, tenantValues } from "./helpers.ts";

const MAX_LIST = 200;

/** Workspace-owned rows (owner "") plus the caller's own personal rows. Used by every read and write. */
function visibleTo(ctx: TenantContext) {
  const userId = ctx.actor.type === "user" ? ctx.actor.id : undefined;
  return userId
    ? or(eq(providerConnections.ownerUserId, ""), eq(providerConnections.ownerUserId, userId))
    : eq(providerConnections.ownerUserId, "");
}

/** A personal row may only be written by the user it belongs to; no other actor can plant one for someone. */
function assertOwnUser(ctx: TenantContext, userId: string, what: string): void {
  if (ctx.actor.type !== "user" || ctx.actor.id !== userId) {
    throw new StudixError("FORBIDDEN", `A personal ${what} can only be created by its own user`);
  }
}

function toConnection(row: typeof providerConnections.$inferSelect): ProviderConnection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    provider: row.provider,
    label: row.label,
    authMethod: row.authMethod,
    owner: row.ownerUserId === "" ? { type: "workspace" } : { type: "user", userId: row.ownerUserId },
    status: row.status,
    billingSource: row.billingSource,
    ...(row.secretRef !== null ? { secretRef: row.secretRef } : {}),
    ...(row.keyHint !== null ? { keyHint: row.keyHint } : {}),
    ...(row.baseUrl !== null ? { baseUrl: row.baseUrl } : {}),
    ...(row.lastTest ? { lastTest: { ...row.lastTest, at: new Date(row.lastTest.at) } } : {}),
    runtimes: row.runtimes,
    version: row.version,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createProviderConnectionRepository(db: StudixDb, clock: Clock): ProviderConnectionRepository {
  return {
    async create(ctx, input) {
      if (input.owner.type === "user") assertOwnUser(ctx, input.owner.userId, "connection");
      const now = clock.now();
      try {
        const rows = await db
          .insert(providerConnections)
          .values({
            id: input.id ?? newId("pconn"),
            ...tenantValues(ctx),
            provider: input.provider,
            label: input.label,
            authMethod: input.authMethod,
            ownerUserId: input.owner.type === "user" ? input.owner.userId : "",
            status: input.status,
            billingSource: input.billingSource,
            secretRef: input.secretRef ?? null,
            keyHint: input.keyHint ?? null,
            baseUrl: input.baseUrl ?? null,
            runtimes: input.runtimes,
            version: 1,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return toConnection(first(rows, "provider connection"));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StudixError("CONFLICT", `A connection labelled "${input.label}" already exists`);
        }
        throw error;
      }
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(providerConnections)
        .where(scoped(providerConnections, ctx, eq(providerConnections.id, id), visibleTo(ctx)));
      return rows[0] ? toConnection(rows[0]) : undefined;
    },
    async list(ctx, query = {}) {
      const rows = await db
        .select()
        .from(providerConnections)
        .where(
          scoped(
            providerConnections,
            ctx,
            visibleTo(ctx),
            query.provider ? eq(providerConnections.provider, query.provider) : undefined,
          ),
        )
        .orderBy(desc(providerConnections.id))
        .limit(MAX_LIST);
      return rows.map(toConnection);
    },
    async update(ctx, id, patch) {
      const rows = await db
        .update(providerConnections)
        .set({
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.secretRef !== undefined ? { secretRef: patch.secretRef } : {}),
          ...(patch.keyHint !== undefined ? { keyHint: patch.keyHint } : {}),
          ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
          ...(patch.runtimes !== undefined ? { runtimes: patch.runtimes } : {}),
          ...(patch.billingSource !== undefined ? { billingSource: patch.billingSource } : {}),
          ...(patch.lastTest !== undefined
            ? { lastTest: { ...patch.lastTest, at: patch.lastTest.at.toISOString() } }
            : {}),
          version: sql`${providerConnections.version} + 1`,
          updatedAt: clock.now(),
        })
        .where(scoped(providerConnections, ctx, eq(providerConnections.id, id), visibleTo(ctx)))
        .returning();
      return toConnection(first(rows, `provider connection ${id}`));
    },
    async delete(ctx, id) {
      const where = scoped(providerConnections, ctx, eq(providerConnections.id, id), visibleTo(ctx));
      const rows = await db
        .delete(providerConnections)
        .where(where)
        .returning({ ref: providerConnections.secretRef });
      // The sealed secret goes with its connection; a dangling credential has no owner left to manage it.
      const secretRef = rows[0]?.ref;
      if (secretRef) {
        await db
          .delete(providerCredentials)
          .where(scoped(providerCredentials, ctx, eq(providerCredentials.secretRef, secretRef)));
      }
    },
  };
}

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

function preferencesVisibleTo(ctx: TenantContext) {
  const userId = ctx.actor.type === "user" ? ctx.actor.id : undefined;
  return userId
    ? or(eq(modelPreferences.scopeUserId, ""), eq(modelPreferences.scopeUserId, userId))
    : eq(modelPreferences.scopeUserId, "");
}

/**
 * Every connection a preference points at (primary and fallbacks) must exist in the caller's workspace,
 * be visible to the caller, and, for a workspace-wide preference, be workspace-owned so one member's
 * personal credential never becomes everyone's default.
 */
async function assertChoicesUsable(
  db: StudixDb,
  ctx: TenantContext,
  scope: "workspace" | "user",
  choices: ReadonlyArray<{ connectionId: string }>,
): Promise<void> {
  const ids = [...new Set(choices.map((c) => c.connectionId))];
  const rows = await db
    .select({ id: providerConnections.id, owner: providerConnections.ownerUserId })
    .from(providerConnections)
    .where(scoped(providerConnections, ctx, inArray(providerConnections.id, ids), visibleTo(ctx)));
  const found = new Map(rows.map((r) => [r.id, r.owner]));
  for (const id of ids) {
    const owner = found.get(id);
    if (owner === undefined) throw new StudixError("NOT_FOUND", `Connection ${id} not found`);
    if (scope === "workspace" && owner !== "") {
      throw new StudixError("VALIDATION", "A workspace preference cannot use a personal connection");
    }
  }
}

export function createModelPreferenceRepository(db: StudixDb, clock: Clock): ModelPreferenceRepository {
  return {
    async upsert(ctx, input) {
      const now = clock.now();
      if (input.scope.type === "user") assertOwnUser(ctx, input.scope.userId, "preference");
      const scopeUserId = input.scope.type === "user" ? input.scope.userId : "";
      await assertChoicesUsable(db, ctx, input.scope.type, [input, ...input.fallbacks]);
      const rows = await db
        .insert(modelPreferences)
        .values({
          id: input.id ?? newId("mpref"),
          ...tenantValues(ctx),
          scopeUserId,
          stage: input.stage,
          runtime: input.runtime,
          connectionId: input.connectionId,
          provider: input.provider,
          modelId: input.modelId,
          allowFallback: input.allowFallback,
          fallbacks: input.fallbacks,
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
          set: {
            connectionId: input.connectionId,
            provider: input.provider,
            modelId: input.modelId,
            allowFallback: input.allowFallback,
            fallbacks: input.fallbacks,
            updatedAt: now,
          },
        })
        .returning();
      return toPreference(first(rows, "model preference"));
    },
    async list(ctx, query = {}) {
      const rows = await db
        .select()
        .from(modelPreferences)
        .where(
          scoped(
            modelPreferences,
            ctx,
            preferencesVisibleTo(ctx),
            query.runtime ? eq(modelPreferences.runtime, query.runtime) : undefined,
          ),
        )
        .orderBy(desc(modelPreferences.id))
        .limit(MAX_LIST);
      return rows.map(toPreference);
    },
    async delete(ctx, id) {
      await db
        .delete(modelPreferences)
        .where(scoped(modelPreferences, ctx, eq(modelPreferences.id, id), preferencesVisibleTo(ctx)));
    },
  };
}

export function createSealedCredentialStore(db: StudixDb, clock: Clock): SealedCredentialStore {
  return {
    async put(ctx, secretRef, sealed) {
      const now = clock.now();
      // Upsert is scoped to the caller's workspace: a ref owned by another workspace conflicts and updates nothing.
      const rows = await db
        .insert(providerCredentials)
        .values({ secretRef, ...tenantValues(ctx), sealed, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: providerCredentials.secretRef,
          set: { sealed, updatedAt: now },
          setWhere: and(
            eq(providerCredentials.workspaceId, ctx.workspaceId),
            eq(providerCredentials.organizationId, ctx.organizationId),
          ),
        })
        .returning({ secretRef: providerCredentials.secretRef });
      if (rows.length === 0)
        throw new StudixError("FORBIDDEN", "Credential reference belongs to another workspace");
    },
    async get(ctx, secretRef) {
      const rows = await db
        .select({ sealed: providerCredentials.sealed })
        .from(providerCredentials)
        .where(scoped(providerCredentials, ctx, eq(providerCredentials.secretRef, secretRef)));
      return rows[0]?.sealed;
    },
    async delete(ctx, secretRef) {
      await db
        .delete(providerCredentials)
        .where(scoped(providerCredentials, ctx, eq(providerCredentials.secretRef, secretRef)));
    },
  };
}

export function createModelSnapshotRepository(db: StudixDb, clock: Clock): ModelSnapshotRepository {
  const read = async (ctx: TenantContext, jobId: string, runtime: AgentRuntimeId, stage: string) => {
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
