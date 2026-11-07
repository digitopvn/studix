import { pgTable, text } from "drizzle-orm/pg-core";
import { type ActorType, updatedAt } from "./columns.ts";
import { organizations, workspaces } from "./tenancy.ts";

/**
 * A workspace's job webhook: Studix POSTs job status changes to `url`, signed with HMAC-SHA256. The signing
 * secret is AES-256-GCM sealed by the app (bound to the workspace id); it is shown once, on creation.
 */
export const workspaceWebhooks = pgTable("workspace_webhooks", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  /** Non-secret display hint, e.g. `whsec_…a1b2`. */
  secretHint: text("secret_hint").notNull(),
  updatedByType: text("updated_by_type").$type<ActorType>(),
  updatedById: text("updated_by_id"),
  updatedAt: updatedAt(),
});
