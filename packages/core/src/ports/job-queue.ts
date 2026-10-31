import type { Job, JobStatus } from "../entities/job.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";

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
}
