import {
  type ErrorCode,
  redact,
  redactDeep,
  StudixError,
  type StudixErrorOptions,
  toStudixError,
} from "@studix/shared";
import { DECISION_FAILURE_REASONS, type DecisionFailureReason, type TokenUsage } from "./decision-types.ts";

/**
 * Decision errors are StudixErrors whose `details.reason` carries a DecisionFailureReason, so the router
 * can tell schema failures from budget refusals without parsing messages. Spend already incurred by a
 * failed attempt travels in `details.costCents` / `details.usage` so it is never lost from the ledger.
 */

export interface DecisionErrorOptions extends Omit<StudixErrorOptions, "details"> {
  details?: Record<string, unknown>;
  costCents?: number;
  usage?: TokenUsage;
  model?: string;
}

export function decisionError(
  code: ErrorCode,
  reason: DecisionFailureReason,
  message: string,
  options: DecisionErrorOptions = {},
): StudixError {
  const { costCents, usage, model, details, ...rest } = options;
  return new StudixError(code, message, {
    ...rest,
    details: {
      ...details,
      reason,
      ...(costCents !== undefined ? { costCents } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  });
}

function isFailureReason(value: unknown): value is DecisionFailureReason {
  return typeof value === "string" && (DECISION_FAILURE_REASONS as readonly string[]).includes(value);
}

const REASON_BY_CODE: Partial<Record<ErrorCode, DecisionFailureReason>> = {
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  RATE_LIMITED: "rate_limited",
  UNAVAILABLE: "unavailable",
  BUDGET_EXCEEDED: "budget_exceeded",
  UNAUTHENTICATED: "auth",
  FORBIDDEN: "auth",
  VALIDATION: "bad_request",
};

/** Failure reason of an error: explicit `details.reason`, else derived from the error code. */
export function failureReason(error: StudixError): DecisionFailureReason {
  const explicit = error.details?.reason;
  if (isFailureReason(explicit)) return explicit;
  return REASON_BY_CODE[error.code] ?? "provider_error";
}

/** Spend recorded on a failed attempt (0 when the provider never billed anything). */
export function failureCostCents(error: StudixError): number {
  const cost = error.details?.costCents;
  return typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : 0;
}

export function failureUsage(error: StudixError): TokenUsage | undefined {
  const usage = error.details?.usage as Partial<TokenUsage> | undefined;
  if (typeof usage?.inputTokens !== "number" || typeof usage.outputTokens !== "number") return undefined;
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
}

/**
 * Normalize anything thrown by a provider into a StudixError whose message, details and stack are
 * redacted. Provider error bodies can echo request headers; nothing secret may survive this step.
 */
export function sanitizeDecisionError(error: unknown): StudixError {
  const err = toStudixError(error, "PROVIDER_ERROR");
  const safe = new StudixError(err.code, redact(err.message), {
    retryable: err.retryable,
    suggestedAction: err.suggestedAction === undefined ? undefined : redact(err.suggestedAction),
    details: err.details === undefined ? undefined : redactDeep(err.details),
  });
  if (err.stack) safe.stack = redact(err.stack);
  return safe;
}
