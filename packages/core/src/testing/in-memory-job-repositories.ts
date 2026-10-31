import { type Clock, StudixError } from "@studix/shared";
import type { Job, Render, Stage, WorkflowRun } from "../entities/job.ts";
import { isTerminalJobStatus } from "../entities/job.ts";
import type { JobQueue } from "../ports/job-queue.ts";
import type {
  JobRepository,
  RenderRepository,
  WorkflowRunRepository,
} from "../repositories/job-repository.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

/** In-memory jobs: implements both the read/update repository and the producer-side queue. */
export function createInMemoryJobStore(clock: Clock): { jobs: JobRepository; queue: JobQueue } {
  const jobs = new InMemoryTenantTable<Job>("job", clock);
  const stages = new InMemoryTenantTable<Stage>("stg", clock, false);

  const repo: JobRepository = {
    async get(ctx, id) {
      return jobs.get(ctx, id);
    },
    async findByIdempotencyKey(ctx, key) {
      return jobs.filter(ctx, (j) => j.idempotencyKey === key)[0];
    },
    async list(ctx, query = {}) {
      return jobs.page(
        ctx,
        query,
        (j) =>
          (query.projectId === undefined || j.projectId === query.projectId) &&
          (query.status === undefined || j.status === query.status),
      );
    },
    async update(ctx, id, patch, options = {}) {
      const current = jobs.require(ctx, id);
      if (options.expectStatus && !options.expectStatus.includes(current.status)) {
        throw new StudixError("CONFLICT", `job ${id} is ${current.status}`, {
          details: { status: current.status, expected: options.expectStatus },
        });
      }
      const { clear = [], ...rest } = patch;
      const next: Partial<Job> = { ...rest };
      for (const field of clear) next[field] = undefined;
      return jobs.update(ctx, id, next);
    },
    async upsertStage(ctx, input) {
      const existing = stages.filter(
        ctx,
        (s) => s.jobId === input.jobId && s.name === input.name && s.attempt === input.attempt,
      )[0];
      if (!existing) return stages.insert(ctx, input);
      // Like the database: a write without mediaJobs keeps the records already stored on the row.
      const { mediaJobs, ...rest } = input;
      return stages.update(ctx, existing.id, mediaJobs === undefined ? rest : input);
    },
    async listStages(ctx, jobId) {
      return stages.filter(ctx, (s) => s.jobId === jobId).reverse();
    },
  };

  const queue: JobQueue = {
    async enqueue(ctx, input) {
      if (input.idempotencyKey) {
        const existing = await repo.findByIdempotencyKey(ctx, input.idempotencyKey);
        if (existing) return { job: existing, created: false };
      }
      const job = jobs.insert(ctx, {
        kind: input.kind,
        projectId: input.projectId,
        workflowRunId: input.workflowRunId,
        status: input.initialStatus ?? "queued",
        progress: 0,
        payload: input.payload,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        runAfter: input.runAfter ?? clock.now(),
        idempotencyKey: input.idempotencyKey,
        cancelRequested: false,
        deadlineAt: input.deadlineAt,
        budgetCents: input.budgetCents,
        spentCents: 0,
        createdBy: input.createdBy,
      });
      return { job, created: true };
    },
    async cancel(ctx, jobId, reason) {
      const job = jobs.require(ctx, jobId);
      if (isTerminalJobStatus(job.status)) return job;
      if (job.status === "running") return jobs.update(ctx, jobId, { cancelRequested: true });
      return jobs.update(ctx, jobId, {
        status: "cancelled",
        cancelRequested: true,
        finishedAt: clock.now(),
        error: { code: "CANCELLED", message: reason ?? "cancelled", retryable: false },
      });
    },
    async retryFailed(ctx, jobId, options) {
      const job = jobs.require(ctx, jobId);
      if (job.status !== "failed") {
        throw new StudixError("CONFLICT", `job ${jobId} is ${job.status}`, {
          details: { status: job.status, expected: ["failed"] },
        });
      }
      const now = clock.now();
      return jobs.update(ctx, jobId, {
        status: "queued",
        runAfter: now,
        maxAttempts: job.attempts + options.maxAttempts,
        cancelRequested: false,
        error: undefined,
        finishedAt: undefined,
        lockedBy: undefined,
        leaseExpiresAt: undefined,
        deadlineAt: job.deadlineAt
          ? new Date(now.getTime() + (job.deadlineAt.getTime() - job.createdAt.getTime()))
          : undefined,
      });
    },
    async resume(ctx, jobId) {
      return repo.update(
        ctx,
        jobId,
        { status: "queued", runAfter: clock.now() },
        { expectStatus: ["waiting_approval"] },
      );
    },
  };
  return { jobs: repo, queue };
}

export function createInMemoryRenderRepository(clock: Clock): RenderRepository {
  const renders = new InMemoryTenantTable<Render>("rnd", clock);
  return {
    async create(ctx, input) {
      return renders.insert(ctx, input);
    },
    async get(ctx, id) {
      return renders.get(ctx, id);
    },
    async update(ctx, id, patch) {
      return renders.update(ctx, id, patch);
    },
    async listByProject(ctx, projectId, query = {}) {
      return renders.page(ctx, query, (r) => r.projectId === projectId);
    },
  };
}

export function createInMemoryWorkflowRunRepository(clock: Clock): WorkflowRunRepository {
  const runs = new InMemoryTenantTable<WorkflowRun>("wfr", clock);
  return {
    async create(ctx, input) {
      return runs.insert(ctx, input);
    },
    async get(ctx, id) {
      return runs.get(ctx, id);
    },
    async update(ctx, id, patch) {
      return runs.update(ctx, id, patch);
    },
  };
}
