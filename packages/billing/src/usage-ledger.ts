import type { TenantContext, UsageEvent } from "@studix/core";
import { StudixError } from "@studix/shared";

/** Well-known usage kinds. Kinds are open strings; these are the ones the worker records in P0. */
export const USAGE_KINDS = {
  /** A planning/decision call to a model provider (tokens or flat fee). */
  providerDecision: "provider.decision",
  /** Seconds of rendered output. */
  renderSeconds: "render.seconds",
  /** One generated image, clip, voice line, music bed or sound effect (provider COGS). */
  mediaGeneration: "media.generation",
  /** Bytes written to object storage. */
  storageBytes: "storage.bytes",
  /** One run of an agent stage (harness or host): tokens in quantity, model spend in costCents. */
  agentRun: "agent.run",
} as const;

/** One billable usage line as recorded by a stage. `costCents` is COGS (what Studix paid). */
export interface UsageInput {
  /**
   * Unique per workspace; recording the same key twice is a no-op, except that a stored
   * `metadata.costSource: "estimate"` is replaced by a receipt for the same key. Use usageDedupeKey().
   */
  dedupeKey: string;
  kind: string;
  quantity: number;
  unit: string;
  /** Fractional cents allowed (token pricing). */
  costCents: number;
  jobId?: string;
  providerExecutionId?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordUsageResult {
  event: UsageEvent;
  /** False when an event with the same dedupe key already existed (a retry, or an estimate replaced by its receipt). */
  created: boolean;
}

/** Append-only usage ledger with idempotent recording and per-job cost rollup. */
export interface UsageLedger {
  record(ctx: TenantContext, input: UsageInput): Promise<RecordUsageResult>;
  /** Sum of COGS cents recorded for a job (fractional). */
  jobCostCents(ctx: TenantContext, jobId: string): Promise<number>;
  /** All usage events of a job, oldest first. */
  listForJob(ctx: TenantContext, jobId: string): Promise<UsageEvent[]>;
}

const KEY_PART = /^[\w.:-]+$/;

/**
 * Attempt-independent key for usage tied to one provider execution: the same execution is one cost no
 * matter how many stage attempts report it (e.g. a retry served from the decision idempotency cache).
 */
export function executionUsageDedupeKey(parts: {
  jobId: string;
  stage: string;
  executionId: string;
}): string {
  for (const value of [parts.jobId, parts.stage, parts.executionId]) {
    if (!KEY_PART.test(value)) {
      throw new StudixError(
        "VALIDATION",
        "usage key parts may only contain letters, digits, '_', '.', ':', '-'",
      );
    }
  }
  return `${parts.jobId}:${parts.stage}:exec:${parts.executionId}`;
}

/**
 * Dedupe key derived from job, stage, attempt and the usage item (e.g. provider execution id or
 * "render"). A stage that re-runs on a new attempt really incurred the cost again, so the attempt is
 * part of the key; re-recording within the same attempt is deduplicated.
 */
export function usageDedupeKey(parts: {
  jobId: string;
  stage: string;
  attempt: number;
  item: string;
}): string {
  if (!Number.isInteger(parts.attempt) || parts.attempt < 1) {
    throw new StudixError("VALIDATION", "usage attempt must be a positive integer");
  }
  for (const value of [parts.jobId, parts.stage, parts.item]) {
    if (!KEY_PART.test(value)) {
      throw new StudixError(
        "VALIDATION",
        "usage key parts may only contain letters, digits, '_', '.', ':', '-'",
        {
          details: { value },
        },
      );
    }
  }
  return `${parts.jobId}:${parts.stage}:${parts.attempt}:${parts.item}`;
}

/** Reject malformed usage at the ledger boundary (fail loudly instead of writing bad accounting). */
export function assertValidUsage(input: UsageInput): void {
  const problems: string[] = [];
  if (!input.dedupeKey || input.dedupeKey.length > 256) problems.push("dedupeKey must be 1-256 chars");
  if (!input.kind || input.kind.length > 64) problems.push("kind must be 1-64 chars");
  if (!input.unit || input.unit.length > 32) problems.push("unit must be 1-32 chars");
  if (!Number.isFinite(input.quantity) || input.quantity < 0) problems.push("quantity must be >= 0");
  if (!Number.isFinite(input.costCents) || input.costCents < 0) problems.push("costCents must be >= 0");
  if (problems.length > 0) {
    throw new StudixError("VALIDATION", `Invalid usage event: ${problems.join("; ")}`, {
      details: { problems, dedupeKey: input.dedupeKey },
    });
  }
}

/** Budgets are whole cents; fractional COGS round up so a budget is never silently overrun. */
export function toBudgetCents(costCents: number): number {
  return Math.ceil(Math.round(costCents * 10_000) / 10_000);
}
