import type { Job, JobStatus } from "../entities/job.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { MediaJobRecord } from "./media-provider.ts";

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

export interface AttachMediaJobInput {
  /** Stage whose journal holds the stuck record. */
  stage: string;
  /** Idempotency key of the record to point at the prediction. */
  idempotencyKey: string;
  /** The Atlas prediction id the operator found in `multix history` or the provider console. */
  predictionId: string;
  /** Who recovered the record; the audit event is written in the same transaction. */
  actor: ActorRef;
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
   * Operator recovery of an Atlas media job journal record stuck in `submitting` (the worker died, or the
   * upstream did not answer, between the intent and the job id). In one transaction that holds the job row
   * locked, it requires the job to be `failed` (no worker holds it), finds the newest record for the key in
   * the named stage, points it at the prediction as `submitted`, and audits `job.media_job_attached`, so
   * {@link JobQueue.retry} collects the paid prediction instead of blocking. A `submitted` record that was
   * never collected can be corrected the same way. The prediction is not checked upstream: the caller must
   * be a platform operator who read it from the provider account, never a tenant.
   * NOT_FOUND when the job, stage or record is missing; CONFLICT when the job is not `failed`, the record is
   * completed or failed, or the prediction is attached to another request; VALIDATION for a malformed id.
   */
  attachMediaJob(ctx: TenantContext, jobId: string, input: AttachMediaJobInput): Promise<MediaJobRecord>;
}
