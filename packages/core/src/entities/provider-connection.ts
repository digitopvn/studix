import type { ActorRef } from "../tenant.ts";
import type { TenantOwned } from "./common.ts";

/*
 * Outbound AI provider authentication. One shared domain for every execution adapter (Pi, Claude Agent
 * SDK, ...): adapters declare which providers and auth methods they can drive, they never keep their own
 * key or OAuth store. This is unrelated to the inbound `stx_` MCP keys in `ApiKey`.
 */

/** Execution adapters that can run an agent with a connection. */
export const AGENT_RUNTIME_IDS = ["pi", "claude-agent-sdk"] as const;
export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

export const PROVIDER_AUTH_METHODS = ["api_key", "oauth"] as const;
export type ProviderAuthMethod = (typeof PROVIDER_AUTH_METHODS)[number];

/** `not_connected` is the absence of a connection row and is only derived for display. */
export const PROVIDER_CONNECTION_STATUSES = [
  "connecting",
  "connected",
  "invalid",
  "expired",
  "restricted",
  "revoked",
  "requires_action",
  "unsupported",
] as const;
export type ProviderConnectionStatus = (typeof PROVIDER_CONNECTION_STATUSES)[number];

/** Only `connected` connections may be handed to a runtime. */
export function isUsableStatus(status: ProviderConnectionStatus): boolean {
  return status === "connected";
}

/**
 * Where the money comes from. `subscription` is never assumed: OAuth against a third-party harness may
 * bill extra usage instead (see ADR 0011), so OAuth connections default to `unknown` until verified.
 */
export const BILLING_SOURCES = ["subscription", "extra-usage", "usage-based", "unknown"] as const;
export type BillingSource = (typeof BILLING_SOURCES)[number];

export type ConnectionOwner =
  | { type: "workspace" }
  /** Personal credential: only this user's jobs may use it, even for other workspace members' reads. */
  | { type: "user"; userId: string };

export interface ProviderConnectionTestResult {
  ok: boolean;
  at: Date;
  latencyMs: number;
  /** Stable machine code (`unauthenticated`, `quota`, `forbidden`, `network`, ...). */
  code?: string;
  message?: string;
}

/**
 * Metadata of one provider credential. The secret itself lives sealed in the credential vault and is
 * reachable only through `secretRef`; this record is safe to return to the dashboard.
 */
export interface ProviderConnection extends TenantOwned {
  /** Provider id in the runtime's catalog (`anthropic`, `openai`, `openrouter`, ...). */
  provider: string;
  label: string;
  authMethod: ProviderAuthMethod;
  owner: ConnectionOwner;
  status: ProviderConnectionStatus;
  billingSource: BillingSource;
  /** Opaque vault reference. Never serialized to clients, traces, MCP or job output. */
  secretRef?: string;
  /** Non-secret hint for display, e.g. `sk-ant-…a1b2`. */
  keyHint?: string;
  /** Only for custom OpenAI-compatible endpoints. */
  baseUrl?: string;
  lastTest?: ProviderConnectionTestResult;
  /** Runtimes the owner allowed this connection to be used with. */
  runtimes: AgentRuntimeId[];
  /** Bumped on every change; job snapshots record it. */
  version: number;
  createdBy: ActorRef;
  updatedAt: Date;
}

/** Dashboard-safe projection: everything except the vault reference. */
export type PublicProviderConnection = Omit<ProviderConnection, "secretRef">;

export function toPublicConnection(connection: ProviderConnection): PublicProviderConnection {
  const { secretRef: _secretRef, ...rest } = connection;
  return rest;
}

/** Who a connection may be used by, for a job started by `userId`. */
export function connectionUsableBy(connection: ProviderConnection, userId: string | undefined): boolean {
  if (!isUsableStatus(connection.status)) return false;
  return connection.owner.type === "workspace" || connection.owner.userId === userId;
}

/* ------------------------------------------------------------------------------------------------ *
 * Model preferences
 * ------------------------------------------------------------------------------------------------ */

/** Workflow stage a model is chosen for. `default` applies to every stage without a specific entry. */
export const DEFAULT_STAGE = "default";

export type PreferenceScope = { type: "workspace" } | { type: "user"; userId: string };

export interface ModelPreference extends TenantOwned {
  scope: PreferenceScope;
  /** `default` or a workflow stage id such as `plan`, `storyboard`, `qa`. */
  stage: string;
  runtime: AgentRuntimeId;
  connectionId: string;
  provider: string;
  modelId: string;
  /**
   * Explicit consent to try `fallbacks` when the primary fails. Without it a failed primary is an error;
   * the runtime never silently switches to another credential that may bill differently.
   */
  allowFallback: boolean;
  fallbacks: ModelChoice[];
  updatedAt: Date;
}

export interface ModelChoice {
  connectionId: string;
  provider: string;
  modelId: string;
}

/** Why a choice was made; shown in the dashboard preview and recorded in the job snapshot. */
export type ModelSelectionSource =
  | "user-stage"
  | "workspace-stage"
  | "user-default"
  | "workspace-default"
  | "explicit";

export interface ModelSelectionQuery {
  runtime: AgentRuntimeId;
  stage: string;
  userId?: string;
}

export interface ResolvedModelSelection {
  source: ModelSelectionSource;
  preference: ModelPreference;
}

/**
 * Precedence (most specific first): the requesting user's stage entry, the workspace stage entry, the
 * user's default, the workspace default. Pure and total: no entry means `undefined`, never a guess.
 */
export const MODEL_PRECEDENCE: ReadonlyArray<ModelSelectionSource> = [
  "user-stage",
  "workspace-stage",
  "user-default",
  "workspace-default",
];

export function resolveModelSelection(
  preferences: readonly ModelPreference[],
  query: ModelSelectionQuery,
): ResolvedModelSelection | undefined {
  const forRuntime = preferences.filter((p) => p.runtime === query.runtime);
  const find = (scope: "user" | "workspace", stage: string) =>
    forRuntime.find(
      (p) =>
        p.stage === stage &&
        (scope === "workspace"
          ? p.scope.type === "workspace"
          : p.scope.type === "user" && query.userId !== undefined && p.scope.userId === query.userId),
    );
  // Asking for the default stage itself must not let the workspace default outrank the user's default.
  const stageEntries = query.stage !== DEFAULT_STAGE;
  const candidates: Array<[ModelSelectionSource, ModelPreference | undefined]> = [
    ["user-stage", stageEntries ? find("user", query.stage) : undefined],
    ["workspace-stage", stageEntries ? find("workspace", query.stage) : undefined],
    ["user-default", find("user", DEFAULT_STAGE)],
    ["workspace-default", find("workspace", DEFAULT_STAGE)],
  ];
  for (const [source, preference] of candidates) {
    if (preference) return { source, preference };
  }
  return undefined;
}

/**
 * Immutable record stored on each job: the effective choice at start time. Re-runs reuse it instead of
 * re-resolving, so a changed preference or rotated key never silently reroutes an existing job.
 */
export interface ResolvedModelSnapshot {
  runtime: AgentRuntimeId;
  stage: string;
  source: ModelSelectionSource;
  connectionId: string;
  connectionVersion: number;
  provider: string;
  modelId: string;
  authMethod: ProviderAuthMethod;
  billingSource: BillingSource;
  allowFallback: boolean;
  fallbacks: ModelChoice[];
}
