import { StudixError } from "@studix/shared";
import type { Job, JobStatus, Stage } from "../entities/job.ts";
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
   * Promote a stage's "submitting" media job record (an Atlas call whose job id never reached the journal)
   * to "submitted" with the upstream job an operator found, so a {@link retry} collects that paid job
   * instead of being blocked. Only a `failed` job qualifies, so no worker holds it, and the job row stays
   * locked while the record is rewritten. NOT_FOUND when the job or the record is missing; CONFLICT when
   * the job is not failed or the record is not "submitting".
   */
  attachMediaJob(ctx: TenantContext, input: AttachMediaJobInput): Promise<MediaJobRecord>;
}

export interface AttachMediaJobInput {
  jobId: string;
  /** Stage whose media job journal holds the record. */
  stage: string;
  idempotencyKey: string;
  /** The upstream job found for the record, e.g. in `multix history` or the Atlas Cloud console. */
  job: ProviderJobRef;
}

/**
 * The stage row and journal that `attachMediaJob` writes: the newest record of the key across the stage's
 * attempts (the record a resumed stage reads) becomes "submitted" with `input.job`.
 */
export function attachToSubmittingRecord(
  rows: readonly Stage[],
  input: AttachMediaJobInput,
  at: Date,
): { stageId: string; mediaJobs: MediaJobRecord[]; record: MediaJobRecord } {
  let found: { row: Stage; record: MediaJobRecord } | undefined;
  for (const row of [...rows].sort((a, b) => a.attempt - b.attempt)) {
    if (row.jobId !== input.jobId || row.name !== input.stage) continue;
    for (const record of row.mediaJobs ?? []) {
      if (record.idempotencyKey !== input.idempotencyKey) continue;
      if (!found || record.updatedAt >= found.record.updatedAt) found = { row, record };
    }
  }
  if (!found) {
    throw new StudixError("NOT_FOUND", `stage ${input.stage} has no media job ${input.idempotencyKey}`);
  }
  if (found.record.state !== "submitting") {
    throw new StudixError("CONFLICT", `media job ${input.idempotencyKey} is ${found.record.state}`, {
      retryable: false,
      details: { state: found.record.state, expected: ["submitting"] },
    });
  }
  const { row, record: current } = found;
  const record: MediaJobRecord = {
    ...current,
    job: { provider: input.job.provider, id: input.job.id },
    state: "submitted",
    updatedAt: at.toISOString(),
  };
  const mediaJobs = (row.mediaJobs ?? []).map((r) => (r === current ? record : r));
  return { stageId: row.id, mediaJobs, record };
}
