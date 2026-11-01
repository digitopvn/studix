import type { AgentRuntimeName, BillingSource, ModelChoice, ResolvedModelSnapshot } from "@studix/core";
import type { StudixErrorPayload } from "@studix/shared";
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { jobs } from "./jobs.ts";
import { tenantColumns } from "./tenancy.ts";

/** Provider ids follow the Pi catalog (`anthropic`, `openai`, `openrouter`, ...); the auth service validates them. */
export type ProviderId = string;
export type ProviderAuthMethod = "api_key" | "oauth_subscription";
export type ProviderConnectionOwner = "workspace" | "user";
export type ProviderConnectionStatus = "available" | "invalid" | "unverified" | "revoked";

/** `at` is stored as an ISO string inside jsonb and revived as a Date by the repository. */
export interface StoredProviderTestResult {
  ok: boolean;
  at: string;
  latencyMs: number;
  httpStatus?: number;
  error?: StudixErrorPayload;
}

/**
 * Outbound AI provider credentials (API keys). `secret_ciphertext` is AES-256-GCM sealed by the app with a
 * key that never reaches the database, bound to the workspace and row id; plaintext is never stored.
 * `owner_key` is `workspace` or `user:<userId>` so one active connection exists per owner, provider and
 * auth method. `runtimes` lists the agent runtimes allowed to spend the key: rows that predate the Pi
 * runtime default to `["claude"]`, so Pi can use an existing key only after someone opts in. `version`
 * increases on every key or runtime change so job snapshots can tell which configuration they ran on.
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: id(),
    ...tenantColumns(),
    provider: text("provider").$type<ProviderId>().notNull(),
    authMethod: text("auth_method").$type<ProviderAuthMethod>().notNull(),
    ownerType: text("owner_type").$type<ProviderConnectionOwner>().notNull(),
    ownerUserId: text("owner_user_id"),
    ownerKey: text("owner_key").notNull(),
    label: text("label").notNull(),
    status: text("status").$type<ProviderConnectionStatus>().notNull(),
    secretCiphertext: text("secret_ciphertext"),
    /** Non-secret display hint, e.g. `sk-ant-…a1b2`. */
    secretHint: text("secret_hint"),
    lastTest: jsonb("last_test").$type<StoredProviderTestResult>(),
    runtimes: jsonb("runtimes").$type<AgentRuntimeName[]>().notNull().default(["claude"]),
    billingSource: text("billing_source").$type<BillingSource>().notNull().default("usage_based"),
    version: integer("version").notNull().default(1),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("provider_connections_active_owner_uq")
      .on(t.workspaceId, t.provider, t.authMethod, t.ownerKey)
      .where(sql`${t.revokedAt} is null`),
    index("provider_connections_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
  ],
);

/**
 * Which model a runtime uses for a stage, workspace-wide (`scope_user_id = ''`) or for one member. The
 * empty string, not NULL, marks workspace scope so the unique index treats it as a value. Deleting a
 * connection row cascades; revoking one deletes its preferences in the same transaction.
 */
export const modelPreferences = pgTable(
  "model_preferences",
  {
    id: id(),
    ...tenantColumns(),
    scopeUserId: text("scope_user_id").notNull().default(""),
    stage: text("stage").notNull(),
    runtime: text("runtime").$type<AgentRuntimeName>().notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    allowFallback: boolean("allow_fallback").notNull().default(false),
    fallbacks: jsonb("fallbacks").$type<ModelChoice[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("model_preferences_scope_uq").on(t.workspaceId, t.scopeUserId, t.stage, t.runtime),
    index("model_preferences_tenant_idx").on(t.workspaceId, t.organizationId),
    index("model_preferences_connection_idx").on(t.connectionId),
  ],
);

/** The model one job resolved per runtime and stage, written once so retries never reroute. */
export const jobModelSnapshots = pgTable(
  "job_model_snapshots",
  {
    ...tenantColumns(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    runtime: text("runtime").$type<AgentRuntimeName>().notNull(),
    stage: text("stage").notNull(),
    snapshot: jsonb("snapshot").$type<ResolvedModelSnapshot>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("job_model_snapshots_uq").on(t.jobId, t.runtime, t.stage)],
);
