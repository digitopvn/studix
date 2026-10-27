import type { NewRecord, ProviderExecution, ProviderExecutionStatus, TenantContext } from "@studix/core";
import { type Logger, newId, type StudixError } from "@studix/shared";
import type { DecisionRequest, TokenUsage } from "../decision-types.ts";

/** ProviderExecution create-input produced for every provider invocation the router makes. */
export type DecisionExecutionRecord = NewRecord<ProviderExecution>;

/**
 * Where the router reports provider invocations (a repository, a ledger, a test array). Kept as a
 * callback interface so this package has no database dependency. Sink failures are logged, never thrown.
 */
export interface ProviderExecutionSink {
  record(ctx: TenantContext, execution: DecisionExecutionRecord): Promise<void> | void;
}

export interface ExecutionOutcome {
  /** Pre-assigned execution id so a usage event can reference the row; generated when omitted. */
  id?: string;
  providerId: string;
  model?: string;
  attempt: number;
  latencyMs: number;
  costCents: number;
  usage?: TokenUsage;
  error?: StudixError;
}

function statusOf(error: StudixError | undefined): ProviderExecutionStatus {
  if (!error) return "succeeded";
  if (error.code === "TIMEOUT") return "timeout";
  if (error.code === "CANCELLED") return "cancelled";
  return "failed";
}

export function buildExecutionRecord(
  request: DecisionRequest<unknown>,
  outcome: ExecutionOutcome,
): DecisionExecutionRecord {
  return {
    id: outcome.id ?? newId("pex"),
    ...(request.jobId !== undefined ? { jobId: request.jobId } : {}),
    ...(request.stageId !== undefined ? { stageId: request.stageId } : {}),
    provider: outcome.providerId,
    ...(outcome.model !== undefined ? { model: outcome.model } : {}),
    operation: `decision.${request.kind}`,
    status: statusOf(outcome.error),
    latencyMs: outcome.latencyMs,
    ...(outcome.usage
      ? { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens }
      : {}),
    costCents: outcome.costCents,
    attempt: outcome.attempt,
    ...(outcome.error ? { error: outcome.error.toJSON() } : {}),
  };
}

/** A hung sink must not hold a decision past its deadline; a row that may not have landed is never referenced. */
export const SINK_TIMEOUT_MS = 2_000;

/**
 * Record one execution and return its id, or undefined when there is no sink or the sink failed.
 * A failing sink is logged (redacted) and never breaks the decision.
 */
export async function recordExecution(
  sink: ProviderExecutionSink | undefined,
  logger: Logger | undefined,
  request: DecisionRequest<unknown>,
  outcome: ExecutionOutcome,
): Promise<string | undefined> {
  if (!sink) return undefined;
  try {
    const record = buildExecutionRecord(request, outcome);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("provider execution sink timed out")), SINK_TIMEOUT_MS);
    });
    try {
      await Promise.race([Promise.resolve(sink.record(request.tenant, record)), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return record.id;
  } catch (error) {
    logger?.error("provider execution sink failed", {
      provider: outcome.providerId,
      kind: request.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
