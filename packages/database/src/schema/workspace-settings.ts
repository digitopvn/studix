import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { type ActorType, updatedAt } from "./columns.ts";
import { organizations, workspaces } from "./tenancy.ts";

/**
 * Feature switches a workspace owner may flip from the dashboard. They only take effect on a server whose
 * operator set STUDIX_SELF_HOSTED; a hosted deployment ignores them. One row per workspace, created on
 * first change; a missing row means every switch is off.
 */
export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  claudePlanner: boolean("claude_planner").notNull().default(false),
  claudeSubscription: boolean("claude_subscription").notNull().default(false),
  updatedByType: text("updated_by_type").$type<ActorType>(),
  updatedById: text("updated_by_id"),
  updatedAt: updatedAt(),
});
