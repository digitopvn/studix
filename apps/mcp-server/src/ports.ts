import type { McpServer } from "@modelcontextprotocol/server";
import type { DashboardAuth } from "@studix/auth";
import type { StorageAdapter, TenantContext } from "@studix/core";
import type { Logger } from "@studix/shared";

/**
 * Ports the HTTP app depends on. Adapters are injected at composition time (src/compose-app.ts), so the
 * storage, gateway and auth implementations plug in without the app importing them.
 */

/**
 * Signs short-lived GET URLs for stored artifacts. Structurally the `signedUrl` method of core's
 * `StorageAdapter`, so the S3 adapter from `@studix/storage` satisfies it directly. Keys are tenant-relative
 * (as stored on `Render.storageKey`); the adapter applies the tenant prefix.
 */
export type ArtifactUrlSigner = Pick<StorageAdapter, "signedUrl">;

/** Dashboard session resolution, the Better Auth node handler and the enabled SSO providers. */
export type DashboardAuthPort = Pick<
  DashboardAuth,
  "nodeHandler" | "resolveSession" | "ssoProviders" | "mcpOAuth"
>;

export const CONNECTOR_STATUSES = ["active", "disabled", "error"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** Client-safe connector record. Never carries credentials or secretRef values. */
export interface ConnectorView {
  id: string;
  name: string;
  url: string;
  status: ConnectorStatus;
  toolCount?: number;
  lastCheckedAt?: Date | string;
  /** Human-readable reason of the last failed check (the dashboard renders it as text). */
  lastError?: string;
  createdAt?: Date | string;
}

/** Which connector tools the workspace may discover and execute; a new connector allows none by default. */
export interface ConnectorToolPolicyInput {
  allow?: string[];
  deny?: string[];
}

export interface AddConnectorInput {
  name: string;
  url: string;
  /** Environment-backed credential reference (`env:STUDIX_CONNECTOR_SECRET_<NAME>`), never the secret itself. */
  secretRef?: string;
  toolPolicy?: ConnectorToolPolicyInput;
}

export interface ConnectorTestResult {
  ok: boolean;
  toolCount?: number;
  /** Qualified tool names (`server.tool`) discovered during the test. */
  tools?: string[];
  /** Human-readable failure reason (the dashboard renders it as text). */
  error?: string;
}

/**
 * Workspace connector administration (third-party MCP servers). Implemented by `@studix/mcp-gateway`;
 * every method is tenant-scoped and must enforce URL policy and permissions itself.
 */
export interface ConnectorAdmin {
  list(ctx: TenantContext): Promise<ConnectorView[]>;
  add(ctx: TenantContext, input: AddConnectorInput): Promise<ConnectorView>;
  test(ctx: TenantContext, connectorId: string): Promise<ConnectorTestResult>;
  disable(ctx: TenantContext, connectorId: string): Promise<ConnectorView>;
}

export interface MetaToolDeps {
  /** Tenant of the authenticated API key for this request. */
  tenant: TenantContext;
  /** Inbound gateway hop count from the `x-studix-gateway-depth` header (0 for direct clients). */
  gatewayDepth: number;
  logger: Logger;
  /** Trace id the meta-tools should echo in their envelopes. */
  traceId: string;
}

/**
 * Registers the MCP-in-MCP meta-tools (`studix_tool_search`, `studix_tool_inspect`, `studix_tool_execute`)
 * on the per-request server. Supplied by the gateway at wiring time; when absent the tools are not listed.
 */
export type RegisterMetaTools = (server: McpServer, deps: MetaToolDeps) => void;

/** A named dependency check for `/readyz`. Resolve when healthy, throw otherwise. */
export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

/** Workflow template advertised by `studix_inspect`. */
export interface SkillSummary {
  id: string;
  title: string;
  description: string;
  version?: number;
}
