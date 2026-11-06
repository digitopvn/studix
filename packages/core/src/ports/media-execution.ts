import { newId, type StudixError } from "@studix/shared";
import type { NewRecord } from "../entities/common.ts";
import type { FundingSource, ProviderExecution, ProviderExecutionStatus } from "../entities/telemetry.ts";
import type { TenantContext } from "../tenant.ts";
import type { MediaKind, ProviderJobRef } from "./media-provider.ts";

/** One media provider call (generate or resume), as it ended. */
export interface MediaExecutionOutcome {
  provider: string;
  model?: string;
  kind: MediaKind;
  jobId?: string;
  stageId?: string;
  latencyMs: number;
  costCents: number;
  /** Submission attempt of the upstream job; 1 when the provider keeps no journal. */
  attempt: number;
  /** Upstream job the call ran as, when the provider reported one. */
  job?: ProviderJobRef;
  error?: StudixError;
  funding?: FundingSource;
}

function statusOf(error: StudixError | undefined): ProviderExecutionStatus {
  if (!error) return "succeeded";
  if (error.code === "TIMEOUT") return "timeout";
  if (error.code === "CANCELLED") return "cancelled";
  return "failed";
}

/** The `provider_executions` row of a media call; `operation` is `media.<kind>`. */
export function mediaExecutionRecord(
  outcome: MediaExecutionOutcome,
  id: string = newId("pex"),
): NewRecord<ProviderExecution> {
  return {
    id,
    ...(outcome.jobId !== undefined ? { jobId: outcome.jobId } : {}),
    ...(outcome.stageId !== undefined ? { stageId: outcome.stageId } : {}),
    provider: outcome.provider,
    ...(outcome.model !== undefined ? { model: outcome.model } : {}),
    operation: `media.${outcome.kind}`,
    status: statusOf(outcome.error),
    latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
    costCents: outcome.costCents,
    attempt: outcome.attempt,
    ...(outcome.error ? { error: outcome.error.toJSON() } : {}),
    ...(outcome.funding ? { funding: outcome.funding } : {}),
    ...(outcome.job ? { externalId: `${outcome.job.provider}:${outcome.job.id}` } : {}),
  };
}

/** Where media callers store execution rows (a usage repository, a test array). */
export interface ProviderExecutionRecorder {
  recordProviderExecution(ctx: TenantContext, input: NewRecord<ProviderExecution>): Promise<unknown>;
}
