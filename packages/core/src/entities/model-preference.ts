import type { TenantOwned } from "./common.ts";

/*
 * Which model an agent runtime uses for a workflow stage, on which stored provider connection. The
 * connection itself (and its sealed key) belongs to the provider-connection service in @studix/auth; this
 * file only holds the choice, how it is resolved and the per-job record of what was resolved.
 */

/** Agent runtimes a provider connection can be enabled for. Matches `PlannerSelection.runtime`. */
export const AGENT_RUNTIMES = ["claude", "pi"] as const;
export type AgentRuntimeName = (typeof AGENT_RUNTIMES)[number];

/**
 * Who pays for a connection's calls. `subscription` is never assumed: an OAuth login through a third-party
 * harness may bill extra usage instead, so only API keys are known to be `usage_based`.
 */
export const BILLING_SOURCES = ["usage_based", "subscription", "extra_usage", "unknown"] as const;
export type BillingSource = (typeof BILLING_SOURCES)[number];

/** `default` applies to every stage without its own entry. */
export const DEFAULT_STAGE = "default";

export type PreferenceScope = { type: "workspace" } | { type: "user"; userId: string };

export interface ModelChoice {
  connectionId: string;
  provider: string;
  modelId: string;
}

export interface ModelPreference extends TenantOwned, ModelChoice {
  scope: PreferenceScope;
  /** `default` or a workflow stage id such as `plan`. */
  stage: string;
  runtime: AgentRuntimeName;
  /**
   * Explicit consent to try `fallbacks` when the primary fails at the provider. Without it a failed primary
   * is a failure; the runtime never switches to another credential that may bill differently.
   */
  allowFallback: boolean;
  fallbacks: ModelChoice[];
  updatedAt: Date;
}

/** Why a model was chosen; shown in the dashboard preview and recorded in the job snapshot. */
export type ModelSelectionSource = "user-stage" | "workspace-stage" | "user-default" | "workspace-default";

export interface ModelSelectionQuery {
  runtime: AgentRuntimeName;
  stage: string;
  /** The person the work runs for; their personal entries outrank the workspace's. */
  userId?: string;
}

export interface ResolvedModelSelection {
  source: ModelSelectionSource;
  preference: ModelPreference;
}

/**
 * Precedence, most specific first: the user's stage entry, the workspace stage entry, the user's default,
 * the workspace default. No entry means `undefined`, never a guess.
 */
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
 * The effective choice for one job, runtime and stage, stored the first time the stage resolves a model.
 * Retries reuse it, so a changed preference never reroutes an existing job; a rotated key keeps working
 * because only the connection id is pinned, never the secret.
 */
export interface ResolvedModelSnapshot extends ModelChoice {
  runtime: AgentRuntimeName;
  stage: string;
  source: ModelSelectionSource;
  /** The connection's version when the snapshot was taken (bumped on key rotation or runtime changes). */
  connectionVersion: number;
  billingSource: BillingSource;
  allowFallback: boolean;
  fallbacks: ModelChoice[];
}

/** True when two snapshots would run the same models on the same connections. */
export function sameModelRoute(a: ResolvedModelSnapshot, b: ResolvedModelSnapshot): boolean {
  const route = (s: ResolvedModelSnapshot) =>
    JSON.stringify([
      s.connectionId,
      s.provider,
      s.modelId,
      s.allowFallback,
      s.fallbacks.map((f) => [f.connectionId, f.provider, f.modelId]),
    ]);
  return route(a) === route(b);
}
