import type { Permission, Role } from "@studix/core";
import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, ts, updatedAt } from "./columns.ts";

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("workspaces_org_slug_uq").on(t.organizationId, t.slug)],
);

/** Tenant columns carried by every tenant-owned table; repositories filter on both. */
export const tenantColumns = () => ({
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
});

/**
 * Dashboard identities. Column/property names follow Better Auth's core schema (user, session, account,
 * verification) so its Drizzle adapter can map onto these tables directly.
 */
export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    /** Password hash for email/password sign-in (never plaintext). */
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_accounts_user_idx").on(t.userId)],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

export const members = pgTable(
  "members",
  {
    id: id(),
    ...tenantColumns(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("members_workspace_user_uq").on(t.workspaceId, t.userId),
    index("members_user_idx").on(t.userId),
  ],
);

/** Workspace API keys (`stx_<env>_<random>`). Only the sha256 hash is stored. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    ...tenantColumns(),
    name: text("name").notNull(),
    hash: text("hash").notNull(),
    prefix: text("prefix").notNull(),
    scopes: jsonb("scopes").$type<Permission[]>().notNull(),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.hash), index("api_keys_workspace_idx").on(t.workspaceId)],
);
