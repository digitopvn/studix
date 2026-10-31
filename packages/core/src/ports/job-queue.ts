import type { Job, JobStatus } from "../entities/job.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";

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

export interface RetryFailedJobOptions {
  /** Attempts the resumed job may use on top of those it already spent. */
  maxAttempts: number;
}

/** Producer side of the durable queue. Worker-side claiming/leasing lives in the workflow package. */
export interface JobQueue {
  enqueue(ctx: TenantContext, input: EnqueueJobInput): Promise<EnqueueResult>;
  /** Cancel immediately when not running; otherwise set cancelRequested for the worker to observe. */
  cancel(ctx: TenantContext, jobId: string, reason?: string): Promise<Job>;
  /** Move a waiting_approval job back to queued. */
  resume(ctx: TenantContext, jobId: string): Promise<Job>;
  /**
   * Requeue a `failed` job as itself (CONFLICT for any other status). Stage checkpoints, the stage media
   * journals, spend, usage events and decided approvals stay, so the resumed run collects what it already
   * paid for instead of submitting it again. The error and lease are cleared, and a deadline restarts with
   * the window it was created with.
   */
  retryFailed(ctx: TenantContext, jobId: string, options: RetryFailedJobOptions): Promise<Job>;
}
