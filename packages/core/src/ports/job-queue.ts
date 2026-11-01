import { StudixError } from "@studix/shared";
import type { Job, JobStatus } from "../entities/job.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { MediaJobRecord, ProviderJobRef } from "./media-provider.ts";

/** Attempts a manually retried job may use before it fails again. */
export const JOB_RESUME_ATTEMPTS = 3;

export interface EnqueueJobInput {
  kind: string;
  projectId?: string;
  workflowRunId?: string;
  payload: Record<string, unknown>;
  /** Unique per workspace; enqueueing the same key again returns the existing job. */
  idempotencyKey?: string;
  budgetCents?: number;
  deadlineAt?: Date;
  maxAttempts?: number;
  runAfter?: Date;
  /** Jobs gated by an approval start in waiting_approval and are resumed by approve(). */
  initialStatus?: Extract<JobStatus, "queued" | "waiting_approval">;
  createdBy: ActorRef;
}

export interface EnqueueResult {
  job: Job;
  /** False when an existing job with the same idempotency key was returned. */
  created: boolean;
}

/** An operator's proof of the upstream job that a `submitting` journal record never learned about. */
export interface AttachMediaJobInput {
  /** Stage whose media job journal holds the `submitting` record. */
  stage: string;
  /** Idempotency key of the media call (the record's key). */
  idempotencyKey: string;
  /** The upstream job found in the provider's history or console. Only Atlas predictions are accepted. */
  job: ProviderJobRef;
}

/** Shape of an upstream job id the media providers accept. */
export const PROVIDER_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Promote the newest `submitting` record of `idempotencyKey` to `submitted` with the operator's job id.
 * `rows` holds the media job records of every stored attempt of the stage; the record that wins is the one
 * the stage journal would read (newest `updatedAt`). Returns the row index and the replacement record.
 * Anything else (no record, a record that already moved on, a non-Atlas job) is refused, so a mistaken
 * call can never turn a collected or released record back into a live one.
 */
export function promoteSubmittingRecord(
  rows: readonly (readonly MediaJobRecord[] | undefined)[],
  input: AttachMediaJobInput,
  now: Date,
): { rowIndex: number; record: MediaJobRecord } {
  if (input.job.provider !== "atlas") {
    throw new StudixError("VALIDATION", "only an Atlas job can be attached to a submitting record", {
      retryable: false,
    });
  }
  if (!PROVIDER_JOB_ID.test(input.job.id)) {
    throw new StudixError("VALIDATION", "job.id is not a valid provider job id", { retryable: false });
  }
  let found: { rowIndex: number; record: MediaJobRecord } | undefined;
  rows.forEach((records, rowIndex) => {
    for (const record of records ?? []) {
      if (record.idempotencyKey !== input.idempotencyKey) continue;
      if (!found || record.updatedAt >= found.record.updatedAt) found = { rowIndex, record };
    }
  });
  if (!found) {
    throw new StudixError("NOT_FOUND", `stage ${input.stage} has no media job ${input.idempotencyKey}`, {
      retryable: false,
    });
  }
  const { record } = found;
  if (record.state !== "submitting" || !record.model.startsWith("atlas:")) {
    throw new StudixError("CONFLICT", "the media job is not an Atlas submission waiting for a job id", {
      retryable: false,
      details: { state: record.state, model: record.model },
    });
  }
  // Never move a record back in time: the stage journal keeps the newest `updatedAt`.
  const at = new Date(Math.max(now.getTime(), Date.parse(record.updatedAt) + 1)).toISOString();
  return {
    rowIndex: found.rowIndex,
    record: { ...record, job: input.job, state: "submitted", updatedAt: at },
  };
}

/** Producer side of the durable queue. Worker-side claiming/leasing lives in the workflow package. */
export interface JobQueue {
  enqueue(ctx: TenantContext, input: EnqueueJobInput): Promise<EnqueueResult>;
  /** Cancel immediately when not running; otherwise set cancelRequested for the worker to observe. */
  cancel(ctx: TenantContext, jobId: string, reason?: string): Promise<Job>;
  /** Move a waiting_approval job back to queued. */
  resume(ctx: TenantContext, jobId: string): Promise<Job>;
  /**
   * Requeue a `failed` job as the same job, so its succeeded stages and its media job journal are kept and
   * a resumed stage collects the upstream jobs it already paid for. Grants a fresh allowance of
   * {@link JOB_RESUME_ATTEMPTS} attempts and restarts the deadline window. Any other status is CONFLICT.
   */
  retry(ctx: TenantContext, jobId: string): Promise<Job>;
  /**
   * Operator recovery of an Atlas call stuck in `submitting` (the worker died, or timed out, after the
   * request may have reached Atlas and before its job id was journaled). In one transaction that locks the
   * job row, only while the job is `failed` (no worker holds it), it moves that record to `submitted` with
   * the id the operator found, so a {@link JobQueue.retry} collects the paid prediction instead of
   * refusing to submit. NOT_FOUND without such a record, CONFLICT when the job is not `failed` or the
   * record already left `submitting`.
   */
  attachMediaJob(ctx: TenantContext, jobId: string, input: AttachMediaJobInput): Promise<Job>;
}
