import type { NewRecord } from "../entities/common.ts";
import type { Job, JobStatus, Render, Stage, WorkflowRun } from "../entities/job.ts";
import type { TenantContext } from "../tenant.ts";
import type { JobListQuery } from "./job-list-query.ts";
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

export interface JobUpdateOptions {
  /** Compare-and-set: fail with CONFLICT unless the current status is one of these. */
  expectStatus?: readonly JobStatus[];
}

/** Read and tenant-scoped mutation of jobs. Creation goes through JobQueue.enqueue. */
export interface JobRepository {
  get(ctx: TenantContext, id: string): Promise<Job | undefined>;
  findByIdempotencyKey(ctx: TenantContext, idempotencyKey: string): Promise<Job | undefined>;
  /** Tenant-scoped page, newest created first unless `sort`/`order` say otherwise. */
  list(ctx: TenantContext, query?: JobListQuery): Promise<Page<Job>>;
  update(ctx: TenantContext, id: string, patch: JobPatch, options?: JobUpdateOptions): Promise<Job>;
  /** Insert or update the stage row identified by (jobId, name, attempt). */
  upsertStage(ctx: TenantContext, stage: Omit<NewRecord<Stage>, "id">): Promise<Stage>;
  listStages(ctx: TenantContext, jobId: string): Promise<Stage[]>;
  /**
   * How busy the shared queue is for a queued job: jobs that run before it and jobs holding a worker slot
   * now. Counts only, across every workspace (workers claim across tenants); no ids or tenants leave here.
   */
  queueLoad(ctx: TenantContext, job: Job): Promise<JobQueueLoad>;
}

export interface JobQueueLoad {
  /** Claimable jobs that a worker takes before this one. */
  ahead: number;
  /** Jobs whose lease is live: each holds a worker slot. */
  running: number;
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
