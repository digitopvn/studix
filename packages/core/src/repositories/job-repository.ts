import type { NewRecord } from "../entities/common.ts";
import type { Job, JobStatus, Render, Stage, WorkflowRun } from "../entities/job.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type JobPatch = Partial<
  Pick<
    Job,
    | "status"
    | "stage"
    | "progress"
    | "result"
    | "error"
    | "attempts"
    | "runAfter"
    | "lockedBy"
    | "leaseExpiresAt"
    | "cancelRequested"
    | "spentCents"
    | "startedAt"
    | "finishedAt"
  >
> & {
  /** Explicitly clear optional fields (e.g. lease on release). */
  clear?: Array<"stage" | "result" | "error" | "lockedBy" | "leaseExpiresAt">;
};

/** Identifies the worker attempt a write belongs to; the write only lands while that attempt still owns the job. */
export interface JobFence {
  workerId: string;
  attempt: number;
}

export interface JobUpdateOptions {
  /** Compare-and-set: fail with CONFLICT unless the current status is one of these. */
  expectStatus?: readonly JobStatus[];
  /** Fail with CONFLICT (details.reason "lease_lost") unless the job is running, locked by this worker on this attempt. */
  fence?: JobFence;
}

/** Read and tenant-scoped mutation of jobs. Creation goes through JobQueue.enqueue. */
export interface JobRepository {
  get(ctx: TenantContext, id: string): Promise<Job | undefined>;
  findByIdempotencyKey(ctx: TenantContext, idempotencyKey: string): Promise<Job | undefined>;
  list(
    ctx: TenantContext,
    query?: PageRequest & { projectId?: string; status?: JobStatus },
  ): Promise<Page<Job>>;
  update(ctx: TenantContext, id: string, patch: JobPatch, options?: JobUpdateOptions): Promise<Job>;
  /**
   * Insert or update the stage row identified by (jobId, name, attempt). With a fence, the write fails
   * with CONFLICT (details.reason "lease_lost") unless that worker attempt still owns the job.
   */
  upsertStage(ctx: TenantContext, stage: Omit<NewRecord<Stage>, "id">, fence?: JobFence): Promise<Stage>;
  listStages(ctx: TenantContext, jobId: string): Promise<Stage[]>;
}

export type NewWorkflowRun = NewRecord<WorkflowRun>;

export interface WorkflowRunRepository {
  create(ctx: TenantContext, input: NewWorkflowRun): Promise<WorkflowRun>;
  get(ctx: TenantContext, id: string): Promise<WorkflowRun | undefined>;
  update(
    ctx: TenantContext,
    id: string,
    patch: Partial<Pick<WorkflowRun, "status" | "finishedAt">>,
  ): Promise<WorkflowRun>;
}

export type NewRender = NewRecord<Render>;
export type RenderPatch = Partial<
  Pick<Render, "status" | "assetVersionId" | "storageKey" | "probe" | "error" | "completedAt">
>;

export interface RenderRepository {
  create(ctx: TenantContext, input: NewRender): Promise<Render>;
  get(ctx: TenantContext, id: string): Promise<Render | undefined>;
  update(ctx: TenantContext, id: string, patch: RenderPatch): Promise<Render>;
  listByProject(ctx: TenantContext, projectId: string, query?: PageRequest): Promise<Page<Render>>;
}
