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
   * the job is not failed, the record is not "submitting", or a media job record of any workspace already
   * refers to that upstream job (collecting it twice would bill one execution twice, or hand one tenant
   * another's output).
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
 * The stage rows and journals that `attachMediaJob` writes. The newest record of the key across the stage's
 * attempts (the record a resumed stage reads) must be "submitting"; it becomes "submitted" with `input.job`,
 * and every copy of the key on the stage's rows is replaced by it. A later attempt persists its whole
 * journal, so stale copies exist, and one stamped by a worker clock ahead of this one would otherwise
 * still win on retry.
 */
export function attachToSubmittingRecord(
  rows: readonly Stage[],
  input: AttachMediaJobInput,
  at: Date,
): { updates: Array<{ stageId: string; mediaJobs: MediaJobRecord[] }>; record: MediaJobRecord } {
  const stageRows = rows.filter((row) => row.jobId === input.jobId && row.name === input.stage);
  let current: MediaJobRecord | undefined;
  for (const row of [...stageRows].sort((a, b) => a.attempt - b.attempt)) {
    for (const record of row.mediaJobs ?? []) {
      if (record.idempotencyKey !== input.idempotencyKey) continue;
      if (!current || record.updatedAt >= current.updatedAt) current = record;
    }
  }
  if (!current) {
    throw new StudixError("NOT_FOUND", `stage ${input.stage} has no media job ${input.idempotencyKey}`);
  }
  if (current.state !== "submitting") {
    throw new StudixError("CONFLICT", `media job ${input.idempotencyKey} is ${current.state}`, {
      retryable: false,
      details: { state: current.state, expected: ["submitting"] },
    });
  }
  const record: MediaJobRecord = {
    ...current,
    job: { provider: input.job.provider, id: input.job.id },
    state: "submitted",
    updatedAt: at.toISOString(),
  };
  const updates = stageRows
    .filter((row) => row.mediaJobs?.some((r) => r.idempotencyKey === input.idempotencyKey))
    .map((row) => ({
      stageId: row.id,
      mediaJobs: (row.mediaJobs ?? []).map((r) => (r.idempotencyKey === input.idempotencyKey ? record : r)),
    }));
  return { updates, record };
}

/** Whether a media job record refers to `job` (used to refuse attaching one upstream job twice). */
export function refersToProviderJob(records: readonly MediaJobRecord[] | undefined, job: ProviderJobRef) {
  return (records ?? []).some((r) => r.job?.provider === job.provider && r.job.id === job.id);
}
