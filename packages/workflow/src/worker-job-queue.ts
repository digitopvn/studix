import { createUsageLedger, type UsageInput } from "@studix/billing";
import type { Job, JobPatch, TenantContext } from "@studix/core";
import {
  createUsageRepository,
  type DbExecutor,
  type StudixDb,
  schema,
  toJob,
  upsertStageRow,
} from "@studix/database";
import { type Clock, type StudixErrorPayload, systemClock } from "@studix/shared";
import { and, asc, eq, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";

const { jobs, approvals, stages } = schema;
type JobSet = Partial<typeof jobs.$inferInsert>;

/** A stage row written on behalf of a claimed attempt (the tenant and job come from the job). */
export type StageWrite = Omit<Parameters<typeof upsertStageRow>[3], "jobId" | "attempt">;

export interface WorkerJobQueueOptions {
  /** How long a claim is valid without a heartbeat. */
  leaseMs: number;
  clock?: Clock;
}

export interface HeartbeatResult {
  /** False when this worker no longer owns the job (lease expired and someone else claimed it). */
  held: boolean;
  cancelRequested: boolean;
  /** The renewed lease expiry, when held. */
  leaseExpiresAt?: Date;
}

/**
 * Worker side of the Postgres queue (the producer side is `createJobStore` in @studix/database).
 * Claims run across tenants because workers are system actors; every write after the claim is guarded
 * by (id, locked_by, attempts, status = running) so a worker that lost its lease cannot overwrite the
 * new owner's state.
 */
export interface WorkerJobQueue {
  /**
   * Claim the next runnable job: queued and due, or running with an expired lease (its worker died).
   * Increments attempts; jobs at maxAttempts are never claimed (see failExhaustedLeases).
   */
  claim(workerId: string): Promise<Job | undefined>;
  heartbeat(job: Job, workerId: string): Promise<HeartbeatResult>;
  /**
   * Fenced writes: each applies only while `workerId` still holds the job at this attempt (running,
   * `locked_by` and `attempts` unchanged), atomically with the ownership check. They return false, and
   * write nothing, once another worker has reclaimed the job, so a stalled process that resumes late
   * cannot touch stage rows, progress, or spend of an attempt it no longer owns.
   */
  updateProgress(
    job: Job,
    workerId: string,
    patch: Pick<JobPatch, "stage" | "progress" | "spentCents">,
  ): Promise<boolean>;
  /** Upsert the stage row (job, name, this attempt). */
  writeStage(job: Job, workerId: string, stage: StageWrite): Promise<boolean>;
  /** Record one usage event (idempotent by its dedupe key). */
  recordUsage(job: Job, workerId: string, usage: UsageInput): Promise<boolean>;
  /**
   * Run business writes (projects, renders) in a transaction that holds the job row locked while
   * ownership is verified, so they apply only while `workerId` still holds this attempt. `held: false`
   * means nothing ran and nothing was written. Lock order is job row first, then the rows `write`
   * touches (projects, renders); anything that locks those first and then cascades to jobs must
   * cancel or lock the job before it.
   */
  transact<T>(
    job: Job,
    workerId: string,
    write: (tx: DbExecutor, ctx: TenantContext) => Promise<T>,
  ): Promise<{ held: true; value: T } | { held: false }>;
  complete(job: Job, workerId: string, result: Record<string, unknown>): Promise<boolean>;
  fail(job: Job, workerId: string, error: StudixErrorPayload): Promise<boolean>;
  cancel(job: Job, workerId: string, error: StudixErrorPayload): Promise<boolean>;
  /** Requeue after a retryable failure; the attempt stays counted. */
  retry(job: Job, workerId: string, error: StudixErrorPayload, runAfter: Date): Promise<boolean>;
  /** Give the job back without consuming the attempt (graceful shutdown). */
  release(job: Job, workerId: string): Promise<boolean>;
  /** Park in waiting_approval without consuming the attempt; resumed by resumeDecidedApprovals. */
  park(job: Job, workerId: string): Promise<boolean>;
  /** Fail running jobs whose lease expired after their last allowed attempt. Returns the count. */
  failExhaustedLeases(): Promise<number>;
  /**
   * Requeue jobs parked by the worker whose latest gating approval (any action except job.start, which
   * the studio service resumes itself) was granted by a human or rejected. Returns the count.
   */
  resumeDecidedApprovals(): Promise<number>;
}

export function createWorkerJobQueue(db: StudixDb, options: WorkerJobQueueOptions): WorkerJobQueue {
  if (!Number.isInteger(options.leaseMs) || options.leaseMs < 100) {
    throw new RangeError("leaseMs must be an integer >= 100");
  }
  const clock = options.clock ?? systemClock;
  const leaseUntil = () => new Date(clock.now().getTime() + options.leaseMs);

  const owned = (job: Job, workerId: string): SQL =>
    and(
      eq(jobs.id, job.id),
      eq(jobs.workspaceId, job.workspaceId),
      eq(jobs.organizationId, job.organizationId),
      eq(jobs.lockedBy, workerId),
      eq(jobs.attempts, job.attempts),
      eq(jobs.status, "running"),
    )!;

  /** Run `write` in a transaction that holds the job row locked while ownership is verified. */
  const transact = async <T>(
    job: Job,
    workerId: string,
    write: (tx: DbExecutor, ctx: TenantContext) => Promise<T>,
  ): Promise<{ held: true; value: T } | { held: false }> => {
    const ctx: TenantContext = {
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
      actor: { type: "system", id: workerId },
    };
    return db.transaction(async (tx) => {
      const held = await tx.select({ id: jobs.id }).from(jobs).where(owned(job, workerId)).for("update");
      if (held.length === 0) return { held: false as const };
      return { held: true as const, value: await write(tx, ctx) };
    });
  };
  const fenced = async (
    job: Job,
    workerId: string,
    write: (tx: DbExecutor, ctx: TenantContext) => Promise<unknown>,
  ): Promise<boolean> => (await transact(job, workerId, write)).held;

  const finish = async (job: Job, workerId: string, set: JobSet): Promise<boolean> => {
    const rows = await db
      .update(jobs)
      .set({ ...set, lockedBy: null, leaseExpiresAt: null, updatedAt: clock.now() })
      .where(owned(job, workerId))
      .returning({ id: jobs.id });
    return rows.length === 1;
  };

  return {
    async claim(workerId) {
      const now = clock.now();
      const candidate = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            or(
              and(eq(jobs.status, "queued"), lte(jobs.runAfter, now)),
              and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, now)),
            ),
            lt(jobs.attempts, jobs.maxAttempts),
          ),
        )
        .orderBy(asc(jobs.runAfter), asc(jobs.id))
        .limit(1)
        .for("update", { skipLocked: true });
      const rows = await db
        .update(jobs)
        .set({
          status: "running",
          attempts: sql`${jobs.attempts} + 1`,
          lockedBy: workerId,
          leaseExpiresAt: leaseUntil(),
          startedAt: sql`coalesce(${jobs.startedAt}, ${now.toISOString()}::timestamptz)`,
          updatedAt: now,
        })
        .where(inArray(jobs.id, candidate))
        .returning();
      if (!rows[0]) return undefined;
      // Stage rows still "running" from earlier attempts belong to workers that are gone or fenced out.
      await db
        .update(stages)
        .set({
          status: "failed",
          finishedAt: now,
          error: {
            code: "CONFLICT",
            message: "Attempt abandoned: the job was reclaimed by another worker",
            retryable: true,
          },
        })
        .where(
          and(
            eq(stages.jobId, rows[0].id),
            eq(stages.status, "running"),
            lt(stages.attempt, rows[0].attempts),
          ),
        );
      return toJob(rows[0]);
    },

    async heartbeat(job, workerId) {
      const rows = await db
        .update(jobs)
        .set({ leaseExpiresAt: leaseUntil(), updatedAt: clock.now() })
        .where(owned(job, workerId))
        .returning({ cancelRequested: jobs.cancelRequested, leaseExpiresAt: jobs.leaseExpiresAt });
      return rows[0]
        ? {
            held: true,
            cancelRequested: rows[0].cancelRequested,
            ...(rows[0].leaseExpiresAt ? { leaseExpiresAt: rows[0].leaseExpiresAt } : {}),
          }
        : { held: false, cancelRequested: false };
    },

    updateProgress: (job, workerId, patch) =>
      fenced(job, workerId, (tx) =>
        tx
          .update(jobs)
          .set({ ...patch, updatedAt: clock.now() })
          .where(eq(jobs.id, job.id)),
      ),

    writeStage: (job, workerId, stage) =>
      fenced(job, workerId, (tx, ctx) =>
        upsertStageRow(tx, clock, ctx, { ...stage, jobId: job.id, attempt: job.attempts }),
      ),

    recordUsage: (job, workerId, usage) =>
      fenced(job, workerId, (tx, ctx) =>
        createUsageLedger(createUsageRepository(tx, clock)).record(ctx, usage),
      ),

    transact,

    complete: (job, workerId, result) =>
      finish(job, workerId, {
        status: "succeeded",
        result,
        error: null,
        progress: 1,
        finishedAt: clock.now(),
      }),
    fail: (job, workerId, error) =>
      finish(job, workerId, { status: "failed", error, finishedAt: clock.now() }),
    cancel: (job, workerId, error) =>
      finish(job, workerId, { status: "cancelled", error, cancelRequested: true, finishedAt: clock.now() }),
    retry: (job, workerId, error, runAfter) => finish(job, workerId, { status: "queued", error, runAfter }),
    release: (job, workerId) =>
      finish(job, workerId, { status: "queued", attempts: job.attempts - 1, runAfter: clock.now() }),
    park: (job, workerId) =>
      finish(job, workerId, { status: "waiting_approval", attempts: job.attempts - 1 }),

    async failExhaustedLeases() {
      const now = clock.now();
      const rows = await db
        .update(jobs)
        .set({
          status: "failed",
          lockedBy: null,
          leaseExpiresAt: null,
          finishedAt: now,
          updatedAt: now,
          error: sql`jsonb_build_object(
            'code', 'INTERNAL',
            'message', 'Worker lease expired on the last allowed attempt (' || ${jobs.attempts} || ' of ' || ${jobs.maxAttempts} || '); the worker probably crashed',
            'retryable', false,
            'suggestedAction', 'Inspect worker logs for this job, then submit it again.',
            'details', jsonb_build_object('reason', 'lease_expired', 'lockedBy', ${jobs.lockedBy})
          )`,
        })
        .where(
          and(
            eq(jobs.status, "running"),
            lt(jobs.leaseExpiresAt, now),
            sql`${jobs.attempts} >= ${jobs.maxAttempts}`,
          ),
        )
        .returning({ id: jobs.id });
      return rows.length;
    },

    async resumeDecidedApprovals() {
      const now = clock.now();
      const rows = await db
        .update(jobs)
        .set({ status: "queued", runAfter: now, updatedAt: now })
        .where(
          and(
            eq(jobs.status, "waiting_approval"),
            // Outer columns are spelled out with the table name: unqualified names would bind to `a`.
            sql`exists (
              select 1 from ${approvals} a
              where a.workspace_id = "jobs"."workspace_id"
                and a.organization_id = "jobs"."organization_id"
                and a.subject_type = 'job'
                and a.subject_id = "jobs"."id"
                and a.action <> 'job.start'
                and ((a.status = 'approved' and a.decided_by_type = 'user') or a.status = 'rejected')
                and a.id = (
                  select max(b.id) from ${approvals} b
                  where b.workspace_id = a.workspace_id and b.subject_type = 'job'
                    and b.subject_id = a.subject_id and b.action = a.action
                )
            )`,
          ),
        )
        .returning({ id: jobs.id });
      return rows.length;
    },
  };
}
