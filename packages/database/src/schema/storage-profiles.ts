import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, updatedAt } from "./columns.ts";
import type { StoredPlatformTest } from "./platform-credentials.ts";

/**
 * Object storage profiles: where new renders and assets are written. A row without `workspace_id` is a platform
 * profile a platform operator manages; a row with one belongs to that workspace (its owners and admins manage
 * it) and overrides the platform choice for that workspace only. The key pair is AES-256-GCM sealed
 * (STUDIX_SECRETS_KEY, bound to the profile id); plaintext is never stored and never returned. At most one
 * row per scope (platform, or one workspace) is `active` (partial unique index). A workspace's active profile wins;
 * otherwise the platform's active profile applies; with neither the S3_* environment settings (profile id `env`) apply. An inactive profile stays readable for the assets that record it, and a profile still referenced
 * by an asset version or render cannot be deleted.
 */
export const storageProfiles = pgTable(
  "storage_profiles",
  {
    id: text("id").primaryKey(),
    /** Owning workspace; null for a platform profile. */
    workspaceId: text("workspace_id"),
    name: text("name").notNull(),
    providerType: text("provider_type").$type<"cloudflare-r2" | "aws-s3" | "s3-compatible">().notNull(),
    endpoint: text("endpoint"),
    bucket: text("bucket").notNull(),
    region: text("region").notNull(),
    forcePathStyle: boolean("force_path_style").notNull().default(false),
    keyPrefix: text("key_prefix").notNull().default(""),
    accessKeyCiphertext: text("access_key_ciphertext").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    /** Non-secret display hints. */
    accessKeyHint: text("access_key_hint").notNull(),
    secretHint: text("secret_hint").notNull(),
    active: boolean("active").notNull().default(false),
    lastTest: jsonb("last_test").$type<StoredPlatformTest>(),
    version: integer("version").notNull().default(1),
    updatedByType: text("updated_by_type").$type<ActorType>().notNull(),
    updatedById: text("updated_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("storage_profiles_one_active_per_scope_uq")
      .on(sql`coalesce(${t.workspaceId}, '')`)
      .where(sql`${t.active}`),
  ],
);
