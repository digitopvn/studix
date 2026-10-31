import type { ActorRef } from "../tenant.ts";
import type { TenantOwned } from "./common.ts";

/** Execution adapters that can use a connection. A provider (e.g. Anthropic) may serve several runtimes. */
export const AGENT_RUNTIME_IDS = ["pi", "claude-agent-sdk"] as const;
export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

/** How a connection authenticates to the provider. These are never interchangeable or auto-substituted. */
export const AUTH_METHODS = ["api_key", "oauth_subscription", "custom_endpoint"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const CONNECTION_STATUSES = [
  "not_connected",
  "connecting",
  "connected",
  "invalid",
  "expired",
  "restricted",
  "revoked",
  "requires_action",
  "unsupported",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Where the cost of a call lands. `unknown` is shown as such, never rounded to "free". */
export const BILLING_SOURCES = ["subscription", "extra-usage", "usage-based", "unknown"] as const;
export type BillingSource = (typeof BILLING_SOURCES)[number];

export type ConnectionOwner = { kind: "user"; userId: string } | { kind: "workspace" };

/**
 * One outbound AI provider credential binding. Metadata only: the secret lives in the CredentialStore
 * behind `secretRef` and is never part of this record, API responses, traces or job output.
 */
export interface ProviderConnection extends TenantOwned {
  /** Provider id as known to the runtime catalog (e.g. `anthropic`, `openai`, `openrouter`). */
  providerId: string;
  authMethod: AuthMethod;
  owner: ConnectionOwner;
  status: ConnectionStatus;
  billingSource: BillingSource;
  /** Opaque reference into the CredentialStore. Absent while not connected. */
  secretRef?: string;
  /** Short non-reversible hint such as `sk-…a1b2` for the UI. */
  maskedHint?: string;
  label?: string;
  /**
   * Workspace-owned only: when set, only these users may resolve the connection. Unset means every
   * workspace member. System/API-key jobs without a user are refused when it is set.
   */
  allowedUserIds?: string[];
  /** Runtimes allowed to resolve this connection. */
  runtimes: AgentRuntimeId[];
  /** Why the connection is restricted/invalid/unsupported, shown with remediation. */
  statusReason?: string;
  lastTestedAt?: Date;
  expiresAt?: Date;
  updatedAt: Date;
  createdBy: ActorRef;
}

/** Statuses a connection must be in to be handed to a runtime. */
export function isUsableConnection(
  connection: Pick<ProviderConnection, "status" | "expiresAt">,
  now: Date,
): boolean {
  if (connection.status !== "connected") return false;
  return !connection.expiresAt || connection.expiresAt.getTime() > now.getTime();
}

/** Where a model preference applies. Precedence is defined by `resolveModelSelection`. */
export type ModelPreferenceScope =
  | { level: "workspace" }
  | { level: "user"; userId: string }
  | { level: "workflow"; workflow: string }
  | { level: "stage"; workflow: string; stage: string };

export interface ModelChoice {
  providerId: string;
  modelId: string;
  /** The exact connection to bill. A model is only valid together with a connection that serves it. */
  connectionId: string;
}

export interface ModelPreference extends TenantOwned {
  scope: ModelPreferenceScope;
  runtime: AgentRuntimeId;
  primary: ModelChoice;
  /**
   * Fallback choices tried in order when the primary is unavailable. Each is an explicit, consented
   * choice; the resolver never invents one and never crosses to a connection that is not listed.
   */
  fallbacks: ModelChoice[];
  updatedAt: Date;
  updatedBy: ActorRef;
}

/**
 * Immutable record of what a job resolved to, stored in job metadata. Holds references only, so a rerun
 * uses the same selection and never silently switches model, provider or credential.
 */
export interface ResolvedModelSnapshot {
  runtime: AgentRuntimeId;
  providerId: string;
  modelId: string;
  connectionId: string;
  authMethod: AuthMethod;
  billingSource: BillingSource;
  /** Preference level and id that produced the choice (also when a fallback was used). */
  source: ModelPreferenceScope["level"];
  preferenceId: string;
  /** True when a listed fallback was used instead of the primary. */
  usedFallback: boolean;
  resolvedAt: string;
}
