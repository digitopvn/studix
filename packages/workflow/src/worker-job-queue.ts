import type { Job } from "@studix/core";
import { type StudixDb, schema, toJob } from "@studix/database";
import { type Clock, type StudixErrorPayload, systemClock } from "@studix/shared";
import { and, asc, eq, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";

const { jobs, approvals } = schema;
type JobSet = Partial<typeof jobs.$inferInsert>;

export interface WorkerJobQueueOptions {
  /** How long a claim is valid without a heartbeat. */
  leaseMs: number;
  clock?: Clock;
}

export interface HeartbeatResult {
  /** False when this worker no longer owns the job (lease expired and someone else claimed it). */
  held: boolean;
  cancelRequested: boolean;
  /**
   * The renewed lease expiry on the database clock, when held. Informational: it is not comparable with
   * the worker's clock, so deadlines are derived from `leaseMs` and the worker's own elapsed time.
   */
  leaseExpiresAt?: Date;
}

/**
 * Worker side of the Postgres queue (the producer side is `createJobStore` in @studix/database).
 * Claims run across tenants because workers are system actors; every write after the claim is guarded
 * by (id, locked_by, attempts, status = running) so a worker that lost its lease cannot overwrite the
 * new owner's state.
 */
export interface WorkerJobQueue {
  /** Length of every lease granted by `claim` and `heartbeat`, counted from the database's now(). */
  readonly leaseMs: number;
  /**
   * Claim the next runnable job: queued and due, or running with an expired lease (its worker died).
   * Increments attempts; jobs at maxAttempts are never claimed (see failExhaustedLeases).
   */
  claim(workerId: string): Promise<Job | undefined>;
  heartbeat(job: Job, workerId: string): Promise<HeartbeatResult>;
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
  // Lease expiry is written and compared on the database clock, so worker clock skew cannot shorten
  // or stretch a lease. now() is the transaction start, never later than the moment the lease is granted.
  const leaseUntil = () => sql`now() + ${options.leaseMs} * interval '1 millisecond'`;

  const owned = (job: Job, workerId: string): SQL =>
    and(
      eq(jobs.id, job.id),
      eq(jobs.workspaceId, job.workspaceId),
      eq(jobs.organizationId, job.organizationId),
      eq(jobs.lockedBy, workerId),
      eq(jobs.attempts, job.attempts),
      eq(jobs.status, "running"),
    )!;

  const finish = async (job: Job, workerId: string, set: JobSet): Promise<boolean> => {
    const rows = await db
      .update(jobs)
      .set({ ...set, lockedBy: null, leaseExpiresAt: null, updatedAt: clock.now() })
      .where(owned(job, workerId))
      .returning({ id: jobs.id });
    return rows.length === 1;
  };

  return {
    leaseMs: options.leaseMs,

    async claim(workerId) {
      const now = clock.now();
      const candidate = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            or(
              and(eq(jobs.status, "queued"), lte(jobs.runAfter, now)),
              and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, sql`now()`)),
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
      return rows[0] ? toJob(rows[0]) : undefined;
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
            lt(jobs.leaseExpiresAt, sql`now()`),
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
