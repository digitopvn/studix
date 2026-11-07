import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { type ActorType, updatedAt } from "./columns.ts";
import { organizations, workspaces } from "./tenancy.ts";

/**
 * A workspace's Multix settings, saved from the dashboard. A null column (or a role missing from `models`)
 * falls back to the server's MULTIX_* env, so a missing row means the workspace runs on the server setup.
 * Vendor keys are not here: they are the workspace's media keys in `provider_connections`.
 */
export const workspaceMultixSettings = pgTable("workspace_multix_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** False turns Multix off for the workspace; null follows the server. */
  enabled: boolean("enabled"),
  waitTimeoutSeconds: integer("wait_timeout_seconds"),
  /** `{ role: "<vendor>:<model>" }`. */
  models: jsonb("models").$type<Record<string, string>>().notNull().default({}),
  voiceLanguageModels: text("voice_language_models"),
  updatedByType: text("updated_by_type").$type<ActorType>(),
  updatedById: text("updated_by_id"),
  updatedAt: updatedAt(),
});
