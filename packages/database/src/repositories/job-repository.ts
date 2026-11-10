import {
  attachToSubmittingRecord,
  decodeJobCursor,
  JOB_RESUME_ATTEMPTS,
  type Job,
  type JobPatch,
  type JobQueue,
  type JobRepository,
  type JobSortField,
  type Stage,
  type TenantContext,
  toJobPage,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { asc, desc, eq, gte, ilike, inArray, lte, type SQL, sql } from "drizzle-orm";
import type { DbExecutor, StudixDb } from "../client.ts";
import { jobs, stages } from "../schema/jobs.ts";
import { actorFrom, first, opt, pageLimit, scoped, tenantValues } from "./helpers.ts";

/** SQL form of `jobAgent(job).runtime`; keep the two in step. */
const jobAgentRuntimeSql = sql<string>`(case
  when ${jobs.payload}->>'agentMode' = 'host' then 'host'
  when ${jobs.payload}->'agent'->>'runtime' in ('claude', 'codex', 'pi') then ${jobs.payload}->'agent'->>'runtime'
  when jsonb_typeof(${jobs.payload}->'planner') = 'object' then 'planner'
  else 'none' end)`;
/** SQL form of `jobAgent(job).model ?? ""`. */
const jobAgentModelSql = sql<string>`(case
  when ${jobAgentRuntimeSql} in ('claude', 'codex', 'pi') then coalesce(${jobs.payload}->'agent'->>'modelId', '')
  else '' end)`;

/**
 * Sort expressions, keyed by the allowlisted field. Text sorts in byte order (collate "C"), nullable
 * text as "", and timestamps truncated to milliseconds, matching the cursor value (see jobSortValue), so
 * keyset pages never skip or repeat a row.
 */
const JOB_SORT_SQL: Record<JobSortField, SQL> = {
  createdAt: sql`date_trunc('milliseconds', ${jobs.createdAt})`,
  updatedAt: sql`date_trunc('milliseconds', ${jobs.updatedAt})`,
  status: sql`${jobs.status} collate "C"`,
  kind: sql`${jobs.kind} collate "C"`,
  stage: sql`coalesce(${jobs.stage}, '') collate "C"`,
  projectId: sql`coalesce(${jobs.projectId}, '') collate "C"`,
  progress: sql`${jobs.progress}`,
  spentCents: sql`${jobs.spentCents}`,
  agent: sql`${jobAgentRuntimeSql} collate "C"`,
  model: sql`${jobAgentModelSql} collate "C"`,
};

/** Id tie-break in byte order, like the in-memory comparator. */
const JOB_ID_SQL = sql`${jobs.id} collate "C"`;

/** ILIKE pattern for a literal substring. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

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
    deadlineRemainingMs: opt(row.deadlineRemainingMs),
    deadlineWindowMs: opt(row.deadlineWindowMs),
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
    mediaJobs: opt(row.mediaJobs),
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
    // Omitted means "keep": progress and outcome writes must not erase the journal of submitted jobs.
    ...(input.mediaJobs !== undefined ? { mediaJobs: input.mediaJobs } : {}),
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
      const sort = query.sort ?? "createdAt";
      const order = query.order ?? "desc";
      const expr = JOB_SORT_SQL[sort];
      const after = query.cursor === undefined ? undefined : decodeJobCursor(query.cursor, sort);
      const cursorValue =
        after === undefined
          ? undefined
          : sort === "createdAt" || sort === "updatedAt"
            ? sql`${new Date(after.value as number).toISOString()}::timestamptz`
            : sort === "progress"
              ? sql`${after.value}::real`
              : sort === "spentCents"
                ? sql`${after.value}::integer`
                : sql`${after.value}::text`;
      const rows = await db
        .select()
        .from(jobs)
        .where(
          scoped(
            jobs,
            ctx,
            after && cursorValue
              ? order === "desc"
                ? sql`(${expr}, ${JOB_ID_SQL}) < (${cursorValue}, ${after.id})`
                : sql`(${expr}, ${JOB_ID_SQL}) > (${cursorValue}, ${after.id})`
              : undefined,
            query.projectId ? eq(jobs.projectId, query.projectId) : undefined,
            query.status?.length ? inArray(jobs.status, query.status) : undefined,
            query.kind?.length ? inArray(jobs.kind, query.kind) : undefined,
            query.stage?.length ? inArray(sql`coalesce(${jobs.stage}, '')`, query.stage) : undefined,
            query.agent?.length ? inArray(jobAgentRuntimeSql, query.agent) : undefined,
            query.modelContains ? ilike(jobAgentModelSql, containsPattern(query.modelContains)) : undefined,
            query.idContains ? ilike(jobs.id, containsPattern(query.idContains)) : undefined,
            query.projectContains ? ilike(jobs.projectId, containsPattern(query.projectContains)) : undefined,
            query.createdFrom ? gte(jobs.createdAt, query.createdFrom) : undefined,
            query.createdTo ? lte(jobs.createdAt, query.createdTo) : undefined,
            query.updatedFrom ? gte(jobs.updatedAt, query.updatedFrom) : undefined,
            query.updatedTo ? lte(jobs.updatedAt, query.updatedTo) : undefined,
            query.progressMin !== undefined ? gte(jobs.progress, query.progressMin) : undefined,
            query.progressMax !== undefined ? lte(jobs.progress, query.progressMax) : undefined,
            query.spentMin !== undefined ? gte(jobs.spentCents, query.spentMin) : undefined,
            query.spentMax !== undefined ? lte(jobs.spentCents, query.spentMax) : undefined,
          ),
        )
        .orderBy(...(order === "desc" ? [desc(expr), desc(JOB_ID_SQL)] : [asc(expr), asc(JOB_ID_SQL)]))
        .limit(limit + 1);
      return toJobPage(rows.map(toJob), limit, sort);
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

    async queueWait(ctx, jobId) {
      const row = await getRow(ctx, jobId);
      if (!row || row.status !== "queued") return undefined;
      const [counts] = await db
        .select({
          ahead: sql<number>`count(*) filter (where ${jobs.status} = 'queued' and ${jobs.runAfter} <= now()
            and (${jobs.runAfter}, ${jobs.id}) < (${row.runAfter.toISOString()}::timestamptz, ${row.id}))::int`,
          running: sql<number>`count(*) filter (where ${jobs.status} = 'running' and ${jobs.leaseExpiresAt} >= now())::int`,
        })
        .from(jobs)
        .where(inArray(jobs.status, ["queued", "running"]));
      return { ahead: counts?.ahead ?? 0, running: counts?.running ?? 0 };
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
          // A job born at a gate has no active execution yet: its deadline starts when it is first claimed.
          ...((input.initialStatus === "waiting_approval" || input.deadlineFromClaim) && input.deadlineAt
            ? {
                deadlineAt: null,
                deadlineRemainingMs: Math.max(0, input.deadlineAt.getTime() - now.getTime()),
              }
            : { deadlineAt: input.deadlineAt ?? null }),
          deadlineWindowMs: input.deadlineAt ? Math.max(0, input.deadlineAt.getTime() - now.getTime()) : null,
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

    async retry(ctx, jobId) {
      const now = clock.now();
      const rows = await db
        .update(jobs)
        .set({
          status: "queued",
          runAfter: now,
          maxAttempts: sql`${jobs.attempts} + ${JOB_RESUME_ATTEMPTS}`,
          cancelRequested: false,
          error: null,
          result: null,
          finishedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          // The window the caller asked for starts again; the failed attempt may have used it up. Jobs created
          // before the window was stored fall back to the span between creation and the deadline.
          // A deadline paused while parked would override the re-armed one at the next claim.
          // With a stored window the deadline is paused until the next claim, so queue time never uses it up.
          deadlineRemainingMs: sql`${jobs.deadlineWindowMs}`,
          deadlineAt: sql`case
            when ${jobs.deadlineWindowMs} is not null then null
            when ${jobs.deadlineAt} is null then null
            else ${now.toISOString()}::timestamptz + (${jobs.deadlineAt} - ${jobs.createdAt}) end`,
          updatedAt: now,
        })
        .where(scoped(jobs, ctx, eq(jobs.id, jobId), eq(jobs.status, "failed")))
        .returning();
      if (!rows[0]) return conflictOrMissing(ctx, jobId, ["failed"]);
      return toJob(rows[0]);
    },

    async resume(ctx, jobId) {
      return repo.update(
        ctx,
        jobId,
        { status: "queued", runAfter: clock.now() },
        { expectStatus: ["waiting_approval"] },
      );
    },

    attachMediaJob: (ctx, input) =>
      db.transaction(async (tx) => {
        // The lock keeps retry and claim out until the record is rewritten; a failed job has no worker.
        const locked = await tx
          .select({ status: jobs.status })
          .from(jobs)
          .where(scoped(jobs, ctx, eq(jobs.id, input.jobId)))
          .for("update");
        if (!locked[0]) throw new StudixError("NOT_FOUND", `job ${input.jobId} not found`);
        if (locked[0].status !== "failed") {
          throw new StudixError("CONFLICT", `job ${input.jobId} is ${locked[0].status}`, {
            details: { status: locked[0].status, expected: ["failed"] },
          });
        }
        // Deliberately not tenant-scoped: an upstream job is collected with the platform's provider key, so
        // one already journaled anywhere must not be attached again. The error does not say where.
        const reference = JSON.stringify([{ job: { provider: input.job.provider, id: input.job.id } }]);
        // Two attaches of one upstream job to different jobs lock different job rows; serialize them here.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media-job:${reference}`}))`);
        const taken = await tx
          .select({ id: stages.id })
          .from(stages)
          .where(sql`${stages.mediaJobs} @> ${reference}::jsonb`)
          .limit(1);
        if (taken[0])
          throw new StudixError("CONFLICT", "that upstream job is already attached to a media job");
        const rows = await tx
          .select()
          .from(stages)
          .where(scoped(stages, ctx, eq(stages.jobId, input.jobId), eq(stages.name, input.stage)));
        const attached = attachToSubmittingRecord(rows.map(toStage), input, clock.now());
        for (const update of attached.updates) {
          await tx
            .update(stages)
            .set({ mediaJobs: update.mediaJobs })
            .where(scoped(stages, ctx, eq(stages.id, update.stageId)));
        }
        return attached.record;
      }),
  };

  return { jobs: repo, queue };
}
