import { StudixError } from "@studix/shared";
import {
  type AgentRuntimeId,
  isUsableConnection,
  type ModelChoice,
  type ModelPreference,
  type ModelPreferenceScope,
  type ProviderConnection,
  type ResolvedModelSnapshot,
} from "../entities/provider-connection.ts";

export interface ModelResolutionRequest {
  runtime: AgentRuntimeId;
  /** The user the job runs on behalf of; user-owned connections are usable only by their owner. */
  userId?: string;
  workflow?: string;
  stage?: string;
  now: Date;
}

/**
 * Whether `providerId/modelId` exists in the runtime's pinned catalog and is available on the connection.
 * Returns a reason when unavailable so the UI and errors can explain it.
 */
export type ModelAvailability = (
  choice: ModelChoice,
  connection: ProviderConnection,
) => { ok: true } | { ok: false; reason: string };

/** Most specific first: stage > workflow > user > workspace. */
const PRECEDENCE: ModelPreferenceScope["level"][] = ["stage", "workflow", "user", "workspace"];

function scopeMatches(scope: ModelPreferenceScope, request: ModelResolutionRequest): boolean {
  switch (scope.level) {
    case "stage":
      return scope.workflow === request.workflow && scope.stage === request.stage;
    case "workflow":
      return scope.workflow === request.workflow;
    case "user":
      return request.userId !== undefined && scope.userId === request.userId;
    case "workspace":
      return true;
    default:
      return false;
  }
}

/** The ordered, applicable preferences for a request (the "effective model" preview uses the same list). */
export function applicablePreferences(
  preferences: readonly ModelPreference[],
  request: ModelResolutionRequest,
): ModelPreference[] {
  return preferences
    .filter((p) => p.runtime === request.runtime && scopeMatches(p.scope, request))
    .sort((a, b) => PRECEDENCE.indexOf(a.scope.level) - PRECEDENCE.indexOf(b.scope.level));
}

interface Problem {
  /** `auth` means the user must (re)connect or switch credential; `unavailable` means the model itself cannot be served. */
  kind: "auth" | "unavailable";
  reason: string;
}

function connectionProblem(
  connection: ProviderConnection | undefined,
  choice: ModelChoice,
  request: ModelResolutionRequest,
): Problem | undefined {
  if (!connection) return { kind: "auth", reason: "connection not found" };
  if (connection.providerId !== choice.providerId) {
    return { kind: "unavailable", reason: "model does not belong to the connection's provider" };
  }
  if (!connection.runtimes.includes(request.runtime)) {
    return { kind: "unavailable", reason: `connection is not enabled for runtime ${request.runtime}` };
  }
  if (connection.owner.kind === "user" && connection.owner.userId !== request.userId) {
    return { kind: "auth", reason: "connection belongs to another user" };
  }
  if (!isUsableConnection(connection, request.now)) {
    return { kind: "auth", reason: `connection is ${connection.status}` };
  }
  return undefined;
}

/**
 * Pick the model for a job. Takes the single most specific applicable preference and tries its primary,
 * then only its explicitly listed fallbacks. It never falls through to a less specific preference or to a
 * different connection that the preference did not name, so a failure cannot move spend to another credential.
 * Throws UNAUTHENTICATED/UNAVAILABLE with the per-choice reasons when nothing is usable.
 */
export function resolveModelSelection(
  preferences: readonly ModelPreference[],
  connections: readonly ProviderConnection[],
  request: ModelResolutionRequest,
  availability: ModelAvailability,
): ResolvedModelSnapshot {
  const [preference] = applicablePreferences(preferences, request);
  if (!preference) {
    throw new StudixError("UNAVAILABLE", `No model is configured for runtime ${request.runtime}`, {
      retryable: false,
      suggestedAction: "Choose a default model under Settings → AI & Models.",
    });
  }
  const byId = new Map(connections.map((c) => [c.id, c]));
  const candidates = [preference.primary, ...preference.fallbacks];
  const rejected: Array<{ providerId: string; modelId: string; connectionId: string } & Problem> = [];

  for (const [index, choice] of candidates.entries()) {
    const connection = byId.get(choice.connectionId);
    let problem = connectionProblem(connection, choice, request);
    if (!problem && connection) {
      const verdict = availability(choice, connection);
      if (!verdict.ok) problem = { kind: "unavailable", reason: verdict.reason };
    }
    if (problem || !connection) {
      rejected.push({ ...choice, ...(problem ?? { kind: "auth", reason: "connection not found" }) });
      continue;
    }
    const usedFallback = index > 0;
    return {
      runtime: request.runtime,
      providerId: choice.providerId,
      modelId: choice.modelId,
      connectionId: connection.id,
      authMethod: connection.authMethod,
      billingSource: connection.billingSource,
      source: usedFallback ? "fallback" : preference.scope.level,
      usedFallback,
      resolvedAt: request.now.toISOString(),
    };
  }

  throw new StudixError(
    rejected.every((r) => r.kind === "auth") ? "UNAUTHENTICATED" : "UNAVAILABLE",
    `No usable model for runtime ${request.runtime}: ${rejected.map((r) => `${r.providerId}/${r.modelId} (${r.reason})`).join("; ")}`,
    {
      retryable: false,
      details: { rejected },
      suggestedAction: "Reconnect the provider or pick another model under Settings → AI & Models.",
    },
  );
}
