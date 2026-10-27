import type { StudixError } from "@studix/shared";
import { decisionError, failureReason } from "../decision-errors.ts";
import type { DecisionRequest, DecisionResult, FallbackStep, TokenUsage } from "../decision-types.ts";

/** Accumulated state of one routed decision: steps taken, total spend and usage across providers. */
export interface RouteState {
  steps: FallbackStep[];
  spent: number;
  usage: TokenUsage;
  attempts: number;
  lastError?: StudixError;
}

export function newRouteState(): RouteState {
  return { steps: [], spent: 0, usage: { inputTokens: 0, outputTokens: 0 }, attempts: 0 };
}

export function accountSpend(state: RouteState, costCents: number, usage: TokenUsage | undefined): void {
  state.spent += costCents;
  if (usage) {
    state.usage = {
      inputTokens: state.usage.inputTokens + usage.inputTokens,
      outputTokens: state.usage.outputTokens + usage.outputTokens,
    };
  }
}

/** The winning provider's result, re-stated with totals for the whole routed decision. */
export function finalizeResult<T>(
  request: DecisionRequest<T>,
  winner: DecisionResult<T>,
  state: RouteState,
  latencyMs: number,
): DecisionResult<T> {
  // A retried-then-successful primary is not a fallback; only earlier providers' failures count.
  const fallbackReason = state.steps.find((s) => s.providerId !== winner.providerId)?.reason;
  return {
    ...winner,
    latencyMs,
    usage: state.usage,
    costCents: state.spent,
    attempts: state.attempts,
    fallbackChain: state.steps,
    ...(fallbackReason ? { fallbackReason } : {}),
    traceId: request.idempotencyKey,
  };
}

/** Fail-closed error once the chain is exhausted: no valid decision means no decision. */
export function exhaustedError(request: DecisionRequest<unknown>, state: RouteState): StudixError {
  const failed = state.steps.filter((s) => s.outcome !== "succeeded");
  const allBudget = failed.length > 0 && failed.every((s) => s.reason === "budget_exceeded");
  const last = state.lastError;
  const code = allBudget ? "BUDGET_EXCEEDED" : (last?.code ?? "UNAVAILABLE");
  const reason = allBudget ? "budget_exceeded" : last ? failureReason(last) : "circuit_open";
  return decisionError(code, reason, `No provider produced a valid "${request.kind}" decision`, {
    retryable: allBudget ? false : (last?.retryable ?? true),
    costCents: state.spent,
    usage: state.usage,
    details: {
      kind: request.kind,
      traceId: request.idempotencyKey,
      attempts: state.attempts,
      fallbackChain: state.steps,
    },
    suggestedAction: allBudget
      ? "Raise the decision budget or route this kind to a cheaper provider."
      : "Retry later or check the decision providers' health; no decision was granted.",
  });
}
