import type {
  AgentRuntimeId,
  BillingSource,
  ModelChoice,
  ProviderAuthMethod,
  ProviderConnectionStatus,
  ResolvedModelSnapshot,
} from "@studix/core";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { jobs } from "./jobs.ts";
import { tenantColumns } from "./tenancy.ts";

/** `at` is an ISO string inside jsonb and revived as a Date by the repository. */
export interface StoredConnectionTest {
  ok: boolean;
  at: string;
  latencyMs: number;
  code?: string;
  message?: string;
}

/**
 * Outbound AI provider connections (metadata only). `owner_user_id` is empty for workspace-owned
 * connections; a user-owned one is visible and usable only by that user. The secret is in
 * `provider_credentials`, reachable through `secret_ref`.
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: id(),
    ...tenantColumns(),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    authMethod: text("auth_method").$type<ProviderAuthMethod>().notNull(),
    ownerUserId: text("owner_user_id").notNull().default(""),
    status: text("status").$type<ProviderConnectionStatus>().notNull(),
    billingSource: text("billing_source").$type<BillingSource>().notNull(),
    secretRef: text("secret_ref"),
    keyHint: text("key_hint"),
    baseUrl: text("base_url"),
    runtimes: jsonb("runtimes").$type<AgentRuntimeId[]>().notNull(),
    lastTest: jsonb("last_test").$type<StoredConnectionTest>(),
    version: integer("version").notNull().default(1),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("provider_connections_workspace_label_uq").on(t.workspaceId, t.ownerUserId, t.label),
    index("provider_connections_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
  ],
);

/** Sealed (AES-256-GCM) secrets. Never selected by list queries; opened only by the credential vault. */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    secretRef: text("secret_ref").primaryKey(),
    ...tenantColumns(),
    sealed: text("sealed").notNull(),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("provider_credentials_tenant_idx").on(t.workspaceId, t.organizationId)],
);

export const modelPreferences = pgTable(
  "model_preferences",
  {
    id: id(),
    ...tenantColumns(),
    /** Empty string for workspace scope so the unique index treats it as a value. */
    scopeUserId: text("scope_user_id").notNull().default(""),
    stage: text("stage").notNull(),
    runtime: text("runtime").$type<AgentRuntimeId>().notNull(),
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

/** One resolved model per (job, runtime, stage), written once when the stage first runs. */
export const jobModelSnapshots = pgTable(
  "job_model_snapshots",
  {
    ...tenantColumns(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    runtime: text("runtime").$type<AgentRuntimeId>().notNull(),
    stage: text("stage").notNull(),
    snapshot: jsonb("snapshot").$type<ResolvedModelSnapshot>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("job_model_snapshots_uq").on(t.jobId, t.runtime, t.stage)],
);
