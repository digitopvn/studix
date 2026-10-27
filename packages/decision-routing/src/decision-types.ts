import type { TenantContext } from "@studix/core";
import type { z } from "zod";

/**
 * Public contract of the Jev decision layer. Workflow, QA and agent runtime only see these types;
 * provider payloads, credentials and transports stay inside the adapters.
 */

/** JSON Schema document describing the decision output (sent to providers that accept one). */
export type JsonSchema = Record<string, unknown>;

export interface DecisionRequest<T> {
  /** Decision type, dot-namespaced (for example `video.plan`, `qa.route`). Selects the provider chain. */
  kind: string;
  tenant: TenantContext;
  /** Decision input; serialized to JSON for model providers, passed as-is to rules. */
  input: unknown;
  /** Output schema; every result is validated against it after normalization. */
  schema: z.ZodType<T>;
  /** JSON Schema of `schema`. Derived with `z.toJSONSchema` when omitted. */
  jsonSchema?: JsonSchema;
  schemaVersion?: string;
  /** Task description for model providers (what to decide and how). */
  instructions?: string;
  /** Hard spend limit for this call in cents (fractional allowed). */
  budgetCents: number;
  /** Total deadline for this call in milliseconds. */
  timeoutMs: number;
  /** Idempotency key, also used as the decision trace id. Unique per workspace and kind. */
  idempotencyKey: string;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /** Optional correlation ids recorded on provider executions and spans. */
  jobId?: string;
  stageId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Why a provider attempt did not produce the decision. */
export const DECISION_FAILURE_REASONS = [
  "schema_invalid",
  "budget_exceeded",
  "timeout",
  "cancelled",
  "rate_limited",
  "unavailable",
  "provider_error",
  "auth",
  "bad_request",
  "unsupported",
  "circuit_open",
] as const;
export type DecisionFailureReason = (typeof DECISION_FAILURE_REASONS)[number];

/** One step of the routing chain: a provider attempt or a skipped provider. */
export interface FallbackStep {
  providerId: string;
  model?: string;
  attempt: number;
  outcome: "succeeded" | "failed" | "skipped";
  reason?: DecisionFailureReason;
  errorCode?: string;
  latencyMs: number;
  costCents: number;
}

export interface DecisionResult<T> {
  /** Validated, typed decision. Never present unless it passed `schema`. */
  output: T;
  providerId: string;
  model: string;
  latencyMs: number;
  usage: TokenUsage;
  /** Total estimated spend for this decision in cents, including failed attempts. */
  costCents: number;
  /** Number of provider invocations made (all providers). */
  attempts: number;
  /** Ordered steps taken; empty when a single adapter is called directly. */
  fallbackChain: FallbackStep[];
  /** Reason the first choice failed when the decision came from a fallback provider. */
  fallbackReason?: DecisionFailureReason;
  /** Invalid output never leaves the decision layer, so this is always true. */
  schemaValid: true;
  traceId: string;
}

/** Stable adapter interface implemented by every decision provider (and by DecisionRouter). */
export interface DecisionProvider {
  readonly id: string;
  /** Upper-bound cost estimate in cents for this request before it is sent. Free providers return 0. */
  estimateCostCents(request: DecisionRequest<unknown>): number;
  decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>>;
}
