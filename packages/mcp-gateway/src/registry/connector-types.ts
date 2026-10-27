import type { ActorRef, TenantContext } from "@studix/core";
import type { StudixErrorPayload } from "@studix/shared";

export const CONNECTOR_STATUSES = ["enabled", "disabled", "revoked"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** Only remote Streamable HTTP is supported; hosted Studix never runs stdio servers. */
export type ConnectorTransport = "streamable-http";

/**
 * Per-connector grant: a tool is permitted only when it matches `allow` and does not match `deny`.
 * Patterns are exact tool names or `*` globs (e.g. `brand_*`). Empty `allow` permits nothing.
 */
export interface ToolPolicy {
  allow: string[];
  deny: string[];
}

/** Hints reported by the downstream server. Used only to make handling stricter, never to grant access. */
export interface ConnectorToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ConnectorToolFlag = "suspicious-instructions" | "schema-truncated" | "description-truncated";

/** A downstream tool as stored after refresh: sanitized, size-bounded, never trusted as instructions. */
export interface ConnectorTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ConnectorToolAnnotations;
  flags: ConnectorToolFlag[];
  /** Size of the original input schema as reported by the server. */
  schemaBytes: number;
}

/** Outcome of the latest test/refresh. */
export interface ConnectorTestResult {
  ok: boolean;
  at: Date;
  latencyMs: number;
  toolCount?: number;
  /** How many tools the server listed beyond the per-connector cap. */
  droppedTools?: number;
  error?: StudixErrorPayload;
}

/**
 * A workspace-registered downstream MCP server. `secretRef` names an outbound credential held by the
 * secret resolver; it is never the credential itself and is never returned to clients.
 */
export interface Connector {
  id: string;
  organizationId: string;
  workspaceId: string;
  /** Unique per workspace; the `<connector>` part of qualified tool names. */
  name: string;
  url: string;
  transport: ConnectorTransport;
  status: ConnectorStatus;
  secretRef?: string;
  toolPolicy: ToolPolicy;
  tools: ConnectorTool[];
  /** Bumped on every change; catalog caches are keyed by it. */
  version: number;
  lastTest?: ConnectorTestResult;
  createdBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewConnector {
  id?: string;
  name: string;
  url: string;
  transport: ConnectorTransport;
  status: ConnectorStatus;
  secretRef?: string;
  toolPolicy: ToolPolicy;
  createdBy: ActorRef;
}

/** Fields an update may change. `secretRef: null` clears the credential reference. */
export interface ConnectorPatch {
  url?: string;
  status?: ConnectorStatus;
  secretRef?: string | null;
  toolPolicy?: ToolPolicy;
  tools?: ConnectorTool[];
  lastTest?: ConnectorTestResult;
}

/** Tenant-scoped connector storage (Postgres in production, in-memory in unit tests). */
export interface ConnectorRepository {
  /** Throws CONFLICT when the name is already used in the workspace. */
  create(ctx: TenantContext, input: NewConnector): Promise<Connector>;
  get(ctx: TenantContext, id: string): Promise<Connector | undefined>;
  getByName(ctx: TenantContext, name: string): Promise<Connector | undefined>;
  /** All connectors of the workspace (bounded), newest first. */
  list(ctx: TenantContext, query?: { status?: ConnectorStatus }): Promise<Connector[]>;
  /** Apply a patch and bump `version`; throws NOT_FOUND for ids outside the workspace. */
  update(ctx: TenantContext, id: string, patch: ConnectorPatch): Promise<Connector>;
}

/** Connector as shown to clients and dashboards: no credential reference, no full tool list. */
export interface ConnectorView {
  id: string;
  name: string;
  url: string;
  transport: ConnectorTransport;
  status: ConnectorStatus;
  hasCredential: boolean;
  toolPolicy: ToolPolicy;
  toolCount: number;
  version: number;
  lastTest?: ConnectorTestResult;
  createdAt: Date;
  updatedAt: Date;
}

export function toConnectorView(connector: Connector): ConnectorView {
  return {
    id: connector.id,
    name: connector.name,
    url: connector.url,
    transport: connector.transport,
    status: connector.status,
    hasCredential: connector.secretRef !== undefined,
    toolPolicy: { allow: [...connector.toolPolicy.allow], deny: [...connector.toolPolicy.deny] },
    toolCount: connector.tools.length,
    version: connector.version,
    ...(connector.lastTest ? { lastTest: connector.lastTest } : {}),
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}
