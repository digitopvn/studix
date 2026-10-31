import type { Job, JobPatch, JobQueue, JobRepository, Stage, TenantContext } from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { DbExecutor, StudixDb } from "../client.ts";
import { jobs, stages } from "../schema/jobs.ts";
import { actorFrom, beforeCursor, first, opt, pageLimit, scoped, tenantValues, toPage } from "./helpers.ts";

type JobRow = typeof jobs.$inferSelect;
type StageRow = typeof stages.$inferSelect;

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    projectId: opt(row.projectId),
    workflowRunId: opt(row.workflowRunId),
    kind: row.kind,
    status: row.status,
    stage: opt(row.stage),
    progress: row.progress,
    payload: row.payload,
    result: opt(row.result),
    error: opt(row.error),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAfter: row.runAfter,
    lockedBy: opt(row.lockedBy),
    leaseExpiresAt: opt(row.leaseExpiresAt),
    idempotencyKey: opt(row.idempotencyKey),
    cancelRequested: row.cancelRequested,
    deadlineAt: opt(row.deadlineAt),
    budgetCents: opt(row.budgetCents),
    spentCents: row.spentCents,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: opt(row.startedAt),
    finishedAt: opt(row.finishedAt),
  };
}

function toStage(row: StageRow): Stage {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    name: row.name,
    attempt: row.attempt,
    status: row.status,
    output: opt(row.output),
    error: opt(row.error),
    startedAt: opt(row.startedAt),
    finishedAt: opt(row.finishedAt),
    createdAt: row.createdAt,
  };
}

/** Insert or update the stage row (jobId, name, attempt); the caller has already checked the job exists. */
export async function upsertStageRow(
  db: DbExecutor,
  clock: Clock,
  ctx: TenantContext,
  input: Parameters<JobRepository["upsertStage"]>[1],
): Promise<Stage> {
  const values = {
    status: input.status,
    output: input.output ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
  };
  const rows = await db
    .insert(stages)
    .values({
      id: newId("stg"),
      ...tenantValues(ctx),
      jobId: input.jobId,
      name: input.name,
      attempt: input.attempt,
      ...values,
      createdAt: clock.now(),
    })
    .onConflictDoUpdate({
      target: [stages.jobId, stages.name, stages.attempt],
      set: values,
      setWhere: scoped(stages, ctx),
    })
    .returning();
  return toStage(first(rows, "stage"));
}

/**
 * Tenant-scoped job persistence. Implements the read/update repository and the producer side of the
 * Postgres queue (enqueue/cancel/resume). Worker claiming and leasing live in the workflow package.
 */
export function createJobStore(db: StudixDb, clock: Clock): { jobs: JobRepository; queue: JobQueue } {
  const getRow = async (ctx: TenantContext, id: string) =>
    (
      await db
        .select()
        .from(jobs)
        .where(scoped(jobs, ctx, eq(jobs.id, id)))
    )[0];

  /** Explain why a conditional update matched nothing. */
  const conflictOrMissing = async (
    ctx: TenantContext,
    id: string,
    expected: readonly string[],
  ): Promise<never> => {
    const row = await getRow(ctx, id);
    if (!row) throw new StudixError("NOT_FOUND", `job ${id} not found`);
    throw new StudixError("CONFLICT", `job ${id} is ${row.status}`, {
      details: { status: row.status, expected },
    });
  };

  const repo: JobRepository = {
    async get(ctx, id) {
      const row = await getRow(ctx, id);
      return row ? toJob(row) : undefined;
    },

    async findByIdempotencyKey(ctx, key) {
      const rows = await db
        .select()
        .from(jobs)
        .where(scoped(jobs, ctx, eq(jobs.idempotencyKey, key)));
      return rows[0] ? toJob(rows[0]) : undefined;
    },

    async list(ctx, query = {}) {
      const limit = pageLimit(query.limit);
      const rows = await db
        .select()
        .from(jobs)
        .where(
          scoped(
            jobs,
            ctx,
            beforeCursor(jobs.id, query.cursor),
            query.projectId ? eq(jobs.projectId, query.projectId) : undefined,
            query.status ? eq(jobs.status, query.status) : undefined,
          ),
        )
        .orderBy(desc(jobs.id))
        .limit(limit + 1);
      return toPage(rows.map(toJob), limit);
    },

    async update(ctx, id, patch: JobPatch, options = {}) {
      const { clear = [], ...values } = patch;
      const set: Partial<typeof jobs.$inferInsert> = { ...values, updatedAt: clock.now() };
      for (const field of clear) set[field] = null;
      const rows = await db
        .update(jobs)
        .set(set)
        .where(
          scoped(
            jobs,
            ctx,
            eq(jobs.id, id),
            options.expectStatus ? inArray(jobs.status, [...options.expectStatus]) : undefined,
          ),
        )
        .returning();
      if (!rows[0]) return conflictOrMissing(ctx, id, options.expectStatus ?? []);
      return toJob(rows[0]);
    },

    async upsertStage(ctx, input) {
      if (!(await getRow(ctx, input.jobId)))
        throw new StudixError("NOT_FOUND", `job ${input.jobId} not found`);
      return upsertStageRow(db, clock, ctx, input);
    },

    async listStages(ctx, jobId) {
      const rows = await db
        .select()
        .from(stages)
        .where(scoped(stages, ctx, eq(stages.jobId, jobId)))
        .orderBy(asc(stages.id));
      return rows.map(toStage);
    },
  };

  const queue: JobQueue = {
    async enqueue(ctx, input) {
      const now = clock.now();
      const inserted = await db
        .insert(jobs)
        .values({
          id: newId("job"),
          ...tenantValues(ctx),
          projectId: input.projectId ?? null,
          workflowRunId: input.workflowRunId ?? null,
          kind: input.kind,
          status: input.initialStatus ?? "queued",
          payload: input.payload,
          maxAttempts: input.maxAttempts ?? 3,
          runAfter: input.runAfter ?? now,
          idempotencyKey: input.idempotencyKey ?? null,
          deadlineAt: input.deadlineAt ?? null,
          budgetCents: input.budgetCents ?? null,
          createdByType: input.createdBy.type,
          createdById: input.createdBy.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [jobs.workspaceId, jobs.idempotencyKey] })
        .returning();
      if (inserted[0]) return { job: toJob(inserted[0]), created: true };
      const existing = input.idempotencyKey
        ? await repo.findByIdempotencyKey(ctx, input.idempotencyKey)
        : undefined;
      if (!existing)
        throw new StudixError("CONFLICT", "job insert conflicted but no idempotent match was found");
      return { job: existing, created: false };
    },

    async cancel(ctx, jobId, reason) {
      const now = clock.now();
      const stopped = await db
        .update(jobs)
        .set({
          status: "cancelled",
          cancelRequested: true,
          finishedAt: now,
          updatedAt: now,
          lockedBy: null,
          leaseExpiresAt: null,
          error: { code: "CANCELLED", message: reason ?? "cancelled", retryable: false },
        })
        .where(
          scoped(
            jobs,
            ctx,
            eq(jobs.id, jobId),
            inArray(jobs.status, ["queued", "waiting_approval", "waiting_host"]),
          ),
        )
        .returning();
      if (stopped[0]) return toJob(stopped[0]);
      const flagged = await db
        .update(jobs)
        .set({ cancelRequested: true, updatedAt: now })
        .where(scoped(jobs, ctx, eq(jobs.id, jobId), eq(jobs.status, "running")))
        .returning();
      if (flagged[0]) return toJob(flagged[0]);
      const row = await getRow(ctx, jobId);
      if (!row) throw new StudixError("NOT_FOUND", `job ${jobId} not found`);
      return toJob(row);
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
