import type { StudixErrorPayload } from "@studix/shared";
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";
import { tenantColumns } from "./tenancy.ts";

export type ProviderId = "anthropic";
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
 * Outbound AI provider credentials (Anthropic API keys today). `secret_ciphertext` is AES-256-GCM
 * sealed by the app with a key that never reaches the database, bound to the workspace and row id;
 * plaintext is never stored. `owner_key` is `workspace` or `user:<userId>` so one active connection
 * exists per owner, provider and auth method.
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
