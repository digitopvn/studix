import type { StudixErrorPayload } from "@studix/shared";
import { index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { type ActorType, createdAt, id, updatedAt } from "./columns.ts";
import { tenantColumns } from "./tenancy.ts";

/*
 * Storage shapes for the MCP-in-MCP connector registry. The domain types live in @studix/mcp-gateway
 * (ConnectorRepository); these mirror them structurally so this package does not depend on the gateway.
 */

export type ConnectorStatusValue = "enabled" | "disabled" | "revoked";

export interface StoredToolPolicy {
  allow: string[];
  deny: string[];
}

export interface StoredConnectorTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  flags: Array<"suspicious-instructions" | "schema-truncated" | "description-truncated">;
  schemaBytes: number;
}

/** `at` is stored as an ISO string inside jsonb and revived as a Date by the repository. */
export interface StoredConnectorTestResult {
  ok: boolean;
  at: string;
  latencyMs: number;
  toolCount?: number;
  droppedTools?: number;
  error?: StudixErrorPayload;
}

/**
 * Workspace-scoped downstream MCP servers. `secret_ref` is an opaque reference to an outbound credential
 * (never the credential). `version` is bumped on every change so catalog caches invalidate.
 */
export const mcpConnectors = pgTable(
  "mcp_connectors",
  {
    id: id(),
    ...tenantColumns(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    transport: text("transport").$type<"streamable-http">().notNull(),
    status: text("status").$type<ConnectorStatusValue>().notNull(),
    secretRef: text("secret_ref"),
    toolPolicy: jsonb("tool_policy").$type<StoredToolPolicy>().notNull(),
    tools: jsonb("tools").$type<StoredConnectorTool[]>().notNull(),
    version: integer("version").notNull().default(1),
    lastTest: jsonb("last_test").$type<StoredConnectorTestResult>(),
    createdByType: text("created_by_type").$type<ActorType>().notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mcp_connectors_workspace_name_uq").on(t.workspaceId, t.name),
    index("mcp_connectors_tenant_idx").on(t.workspaceId, t.organizationId, t.id),
  ],
);
