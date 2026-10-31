import type { ActorRef, AgentRuntimeName, BillingSource, TenantContext } from "@studix/core";
import { type Clock, StudixError } from "@studix/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import {
  modelPreferences,
  type ProviderAuthMethod,
  type ProviderConnectionOwner,
  type ProviderConnectionStatus,
  type ProviderId,
  providerConnections,
  type StoredProviderTestResult,
} from "../schema/provider-connections.ts";
import { actorFrom, first, isUniqueViolation, opt, scoped, tenantValues } from "./helpers.ts";

export interface ProviderTestResultRecord extends Omit<StoredProviderTestResult, "at"> {
  at: Date;
}

export interface ProviderConnectionRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  provider: ProviderId;
  authMethod: ProviderAuthMethod;
  ownerType: ProviderConnectionOwner;
  ownerUserId?: string;
  label: string;
  status: ProviderConnectionStatus;
  /** Sealed secret; only the credential service may open it. */
  secretCiphertext?: string;
  secretHint?: string;
  lastTest?: ProviderTestResultRecord;
  /** Agent runtimes allowed to spend this credential. */
  runtimes: AgentRuntimeName[];
  billingSource: BillingSource;
  /** Bumped on every key rotation or runtime change. */
  version: number;
  createdBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date;
}

export interface NewProviderConnectionRecord {
  /** Callers pre-generate the id because the ciphertext is bound to it. */
  id: string;
  provider: ProviderId;
  authMethod: ProviderAuthMethod;
  ownerType: ProviderConnectionOwner;
  ownerUserId?: string;
  label: string;
  status: ProviderConnectionStatus;
  secretCiphertext: string;
  secretHint: string;
  lastTest?: ProviderTestResultRecord;
  runtimes: AgentRuntimeName[];
  billingSource: BillingSource;
  createdBy: ActorRef;
}

export interface ProviderConnectionPatch {
  label?: string;
  status?: ProviderConnectionStatus;
  secretCiphertext?: string;
  secretHint?: string;
  lastTest?: ProviderTestResultRecord;
  runtimes?: AgentRuntimeName[];
}

export interface ProviderConnectionRepository {
  create(ctx: TenantContext, input: NewProviderConnectionRecord): Promise<ProviderConnectionRecord>;
  get(ctx: TenantContext, id: string): Promise<ProviderConnectionRecord | undefined>;
  /** Active (not revoked) connections of the workspace, newest first. */
  listActive(ctx: TenantContext): Promise<ProviderConnectionRecord[]>;
  /**
   * Patch an active connection; NOT_FOUND when it is missing or revoked. A new secret or runtime list bumps
   * `version`.
   */
  update(ctx: TenantContext, id: string, patch: ProviderConnectionPatch): Promise<ProviderConnectionRecord>;
  /**
   * Store a test result only if the key is still the one that was tested; undefined when the key was
   * replaced or revoked meanwhile, so a slow test of an old key never overwrites a fresh one.
   */
  recordTest(
    ctx: TenantContext,
    id: string,
    testedCiphertext: string,
    patch: Pick<ProviderConnectionPatch, "status" | "lastTest">,
  ): Promise<ProviderConnectionRecord | undefined>;
  /** Mark revoked, erase the ciphertext and delete the model preferences that point at it. */
  revoke(ctx: TenantContext, id: string): Promise<ProviderConnectionRecord>;
}

function ownerKey(type: ProviderConnectionOwner, userId: string | undefined): string {
  return type === "workspace" ? "workspace" : `user:${userId}`;
}

function toRecord(row: typeof providerConnections.$inferSelect): ProviderConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    provider: row.provider,
    authMethod: row.authMethod,
    ownerType: row.ownerType,
    ownerUserId: opt(row.ownerUserId),
    label: row.label,
    status: row.status,
    secretCiphertext: opt(row.secretCiphertext),
    secretHint: opt(row.secretHint),
    ...(row.lastTest ? { lastTest: { ...row.lastTest, at: new Date(row.lastTest.at) } } : {}),
    runtimes: row.runtimes,
    billingSource: row.billingSource,
    version: row.version,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: opt(row.revokedAt),
  };
}

function storedTest(test: ProviderTestResultRecord | undefined): StoredProviderTestResult | undefined {
  return test ? { ...test, at: test.at.toISOString() } : undefined;
}

/** Upper bound on connections returned by `listActive` (one per owner, provider and method). */
const MAX_LIST = 200;

export function createProviderConnectionRepository(db: StudixDb, clock: Clock): ProviderConnectionRepository {
  return {
    async create(ctx, input) {
      if ((input.ownerType === "user") !== (input.ownerUserId !== undefined)) {
        throw new StudixError("VALIDATION", "ownerUserId is required exactly for user-owned connections");
      }
      const now = clock.now();
      try {
        const rows = await db
          .insert(providerConnections)
          .values({
            id: input.id,
            ...tenantValues(ctx),
            provider: input.provider,
            authMethod: input.authMethod,
            ownerType: input.ownerType,
            ownerUserId: input.ownerUserId ?? null,
            ownerKey: ownerKey(input.ownerType, input.ownerUserId),
            label: input.label,
            status: input.status,
            secretCiphertext: input.secretCiphertext,
            secretHint: input.secretHint,
            lastTest: storedTest(input.lastTest) ?? null,
            runtimes: input.runtimes,
            billingSource: input.billingSource,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return toRecord(first(rows, "provider connection"));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StudixError("CONFLICT", "An active connection already exists for this owner", {
            retryable: false,
            suggestedAction: "Replace the existing key instead of adding another one.",
          });
        }
        throw error;
      }
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(providerConnections)
        .where(scoped(providerConnections, ctx, eq(providerConnections.id, id)));
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async listActive(ctx) {
      const rows = await db
        .select()
        .from(providerConnections)
        .where(scoped(providerConnections, ctx, isNull(providerConnections.revokedAt)))
        .orderBy(desc(providerConnections.id))
        .limit(MAX_LIST);
      return rows.map(toRecord);
    },
    async update(ctx, id, patch) {
      const rows = await db
        .update(providerConnections)
        .set({
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.secretCiphertext !== undefined ? { secretCiphertext: patch.secretCiphertext } : {}),
          ...(patch.secretHint !== undefined ? { secretHint: patch.secretHint } : {}),
          ...(patch.lastTest !== undefined ? { lastTest: storedTest(patch.lastTest) } : {}),
          ...(patch.runtimes !== undefined ? { runtimes: patch.runtimes } : {}),
          ...(patch.secretCiphertext !== undefined || patch.runtimes !== undefined
            ? { version: sql`${providerConnections.version} + 1` }
            : {}),
          updatedAt: clock.now(),
        })
        .where(
          scoped(
            providerConnections,
            ctx,
            and(eq(providerConnections.id, id), isNull(providerConnections.revokedAt)),
          ),
        )
        .returning();
      return toRecord(first(rows, `provider connection ${id}`));
    },
    async recordTest(ctx, id, testedCiphertext, patch) {
      const rows = await db
        .update(providerConnections)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.lastTest !== undefined ? { lastTest: storedTest(patch.lastTest) } : {}),
          updatedAt: clock.now(),
        })
        .where(
          scoped(
            providerConnections,
            ctx,
            and(
              eq(providerConnections.id, id),
              isNull(providerConnections.revokedAt),
              eq(providerConnections.secretCiphertext, testedCiphertext),
            ),
          ),
        )
        .returning();
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
    async revoke(ctx, id) {
      const now = clock.now();
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(providerConnections)
          .set({ status: "revoked", secretCiphertext: null, revokedAt: now, updatedAt: now })
          .where(
            scoped(
              providerConnections,
              ctx,
              and(eq(providerConnections.id, id), isNull(providerConnections.revokedAt)),
            ),
          )
          .returning();
        const revoked = toRecord(first(rows, `provider connection ${id}`));
        // A preference on a revoked key can never run; dropping it lets resolution fall through to the next entry.
        await tx
          .delete(modelPreferences)
          .where(scoped(modelPreferences, ctx, eq(modelPreferences.connectionId, id)));
        return revoked;
      });
    },
  };
}
