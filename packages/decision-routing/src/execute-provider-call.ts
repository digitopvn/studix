import type { Clock, Logger } from "@studix/shared";
import type { z } from "zod";
import { createDeadline, deadlineError, raceWithSignal } from "./abort-signals.ts";
import { decisionError, failureReason, sanitizeDecisionError } from "./decision-errors.ts";
import { resolveJsonSchema, validateDecisionRequest } from "./decision-request-validation.ts";
import type { DecisionRequest, DecisionResult, JsonSchema, TokenUsage } from "./decision-types.ts";

/**
 * The pipeline every adapter runs a call through, so the contract (validation, budget, deadline,
 * cancellation, schema enforcement, redaction) is implemented once and cannot drift per provider.
 * Adapters only implement `invoke`: talk to the provider and return its normalized raw output.
 */

export interface ProviderInvocation {
  /** Normalized provider output, validated here: JSON text (model providers) or a value (rules, fakes). */
  raw: unknown;
  encoding: "json-text" | "value";
  model: string;
  usage: TokenUsage;
  costCents: number;
}

export interface ProviderCallContext {
  /** Aborts on caller cancellation or deadline; pass it to fetch/sleeps. */
  signal: AbortSignal;
  jsonSchema: JsonSchema;
}

export interface ExecuteProviderCallOptions {
  providerId: string;
  clock: Clock;
  logger?: Logger;
  estimateCostCents: number;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

function parseOutput<T>(invocation: ProviderInvocation, schema: z.ZodType<T>): T {
  const spend = { costCents: invocation.costCents, usage: invocation.usage, model: invocation.model };
  let value = invocation.raw;
  if (invocation.encoding === "json-text") {
    try {
      value = JSON.parse(String(value));
    } catch {
      throw decisionError("PROVIDER_ERROR", "schema_invalid", "Provider returned output that is not JSON", {
        retryable: true,
        ...spend,
      });
    }
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Only paths and codes leave the adapter; the invalid payload itself is never surfaced.
  const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
  }));
  throw decisionError("PROVIDER_ERROR", "schema_invalid", "Provider output failed schema validation", {
    retryable: true,
    details: { issues },
    ...spend,
  });
}

export async function executeProviderCall<T>(
  request: DecisionRequest<T>,
  options: ExecuteProviderCallOptions,
  invoke: (context: ProviderCallContext) => Promise<ProviderInvocation>,
): Promise<DecisionResult<T>> {
  const started = options.clock.now().getTime();
  try {
    validateDecisionRequest(request);
    if (request.signal?.aborted) {
      throw decisionError("CANCELLED", "cancelled", "Decision was cancelled by the caller", {
        retryable: false,
      });
    }
    if (options.estimateCostCents > request.budgetCents) {
      throw decisionError(
        "BUDGET_EXCEEDED",
        "budget_exceeded",
        "Estimated cost exceeds the decision budget",
        {
          retryable: false,
          details: { estimateCents: options.estimateCostCents, budgetCents: request.budgetCents },
        },
      );
    }
    const jsonSchema = resolveJsonSchema(request);
    const deadline = createDeadline(request.timeoutMs, request.signal);
    let invocation: ProviderInvocation;
    try {
      invocation = await raceWithSignal(invoke({ signal: deadline.signal, jsonSchema }), deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted) throw deadlineError(deadline, request.timeoutMs);
      throw error;
    } finally {
      deadline.dispose();
    }
    const output = parseOutput(invocation, request.schema);
    if (invocation.costCents > request.budgetCents) {
      throw decisionError("BUDGET_EXCEEDED", "budget_exceeded", "Actual cost exceeded the decision budget", {
        retryable: false,
        costCents: invocation.costCents,
        usage: invocation.usage,
        model: invocation.model,
        details: { budgetCents: request.budgetCents },
      });
    }
    return {
      output,
      providerId: options.providerId,
      model: invocation.model,
      latencyMs: options.clock.now().getTime() - started,
      usage: invocation.usage,
      costCents: invocation.costCents,
      attempts: 1,
      fallbackChain: [],
      schemaValid: true,
      traceId: request.idempotencyKey,
    };
  } catch (error) {
    const safe = sanitizeDecisionError(error);
    options.logger?.warn("decision provider call failed", {
      provider: options.providerId,
      kind: request?.kind,
      traceId: request?.idempotencyKey,
      error: safe.toJSON(),
      reason: failureReason(safe),
    });
    throw safe;
  }
}
