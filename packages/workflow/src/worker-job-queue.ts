import { createUsageLedger, type UsageInput } from "@studix/billing";
import {
  type Approval,
  type ApprovalAction,
  actorRef,
  type Job,
  type JobPatch,
  type TenantContext,
} from "@studix/core";
import {
  createApprovalRepository,
  createAuditRepository,
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

/** A gated action's pending approval request, opened on behalf of a claimed attempt. */
export interface ApprovalRequest {
  action: ApprovalAction;
  reason: string;
  estimatedCostCents?: number;
  /** Lifetime of a newly opened request. */
  ttlMs: number;
}

/**
 * `lost`: this worker no longer owns the job, nothing was written. `existing`: a live request was reused.
 * `decided`: a reviewer decided the latest request after the caller last looked, so nothing was opened
 * and the caller must act on that decision instead of shadowing it with a new pending request.
 */
export type ApprovalRequestResult =
  | { status: "lost" }
  | { status: "created" | "existing" | "decided"; approval: Approval };

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
   * Open the pending approval for a gated action and audit it, in one transaction fenced like the writes
   * above. A live pending request for the same action is reused, so a stale worker can neither add a
   * duplicate that shadows the owner's request nor leave a pending one behind for a finished job.
   */
  requestApproval(job: Job, workerId: string, request: ApprovalRequest): Promise<ApprovalRequestResult>;
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
  /**
   * Close pending approvals that expired while their job is parked in waiting_approval, and fail the job
   * (nobody can decide an expired request, so it would never move again). A job that still has another live
   * pending request keeps waiting. Returns the number of jobs failed.
   */
  failExpiredApprovals(): Promise<number>;
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
  const fenced = async (
    job: Job,
    workerId: string,
    write: (tx: DbExecutor, ctx: TenantContext) => Promise<unknown>,
  ): Promise<boolean> => {
    const ctx: TenantContext = {
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
      actor: { type: "system", id: workerId },
    };
    return db.transaction(async (tx) => {
      const held = await tx.select({ id: jobs.id }).from(jobs).where(owned(job, workerId)).for("update");
      if (held.length === 0) return false;
      await write(tx, ctx);
      return true;
    });
  };

  const requestApproval: WorkerJobQueue["requestApproval"] = async (job, workerId, request) => {
    let result: ApprovalRequestResult = { status: "lost" };
    const held = await fenced(job, workerId, async (tx, ctx) => {
      const approvalRepo = createApprovalRepository(tx, clock);
      const subject = { type: "job" as const, id: job.id };
      const latest = await approvalRepo.findLatest(ctx, subject, request.action);
      const now = clock.now();
      if (
        latest &&
        (latest.status === "rejected" || (latest.status === "approved" && latest.decidedBy?.type === "user"))
      ) {
        result = { status: "decided", approval: latest };
        return;
      }
      if (latest?.status === "pending" && (latest.expiresAt === undefined || latest.expiresAt > now)) {
        result = { status: "existing", approval: latest };
        return;
      }
      const opened = await approvalRepo.open(ctx, {
        action: request.action,
        subject,
        reason: request.reason,
        estimatedCostCents: request.estimatedCostCents,
        requestedBy: actorRef(ctx.actor),
        expiresAt: new Date(now.getTime() + request.ttlMs),
      });
      // A studio request for the same job and action can have opened it between the read and the insert.
      if (!opened.created) {
        result = { status: "existing", approval: opened.approval };
        return;
      }
      const approval = opened.approval;
      await createAuditRepository(tx, clock).append(ctx, {
        actor: actorRef(ctx.actor),
        action: "approval.requested",
        subjectType: "job",
        subjectId: job.id,
        data: { approvalId: approval.id, action: request.action, reason: request.reason },
      });
      result = { status: "created", approval };
    });
    return held ? result : { status: "lost" };
  };

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

    requestApproval,

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

    async failExpiredApprovals() {
      const now = clock.now();
      return db.transaction(async (tx) => {
        // Close requests that are still pending past their expiry on parked jobs, with an audit entry.
        const closed = await tx
          .update(approvals)
          .set({ status: "expired", decidedAt: now })
          .where(
            and(
              eq(approvals.status, "pending"),
              eq(approvals.subjectType, "job"),
              lte(approvals.expiresAt, now),
              sql`exists (
                select 1 from ${jobs} j
                where j.id = ${approvals.subjectId} and j.workspace_id = ${approvals.workspaceId}
                  and j.organization_id = ${approvals.organizationId} and j.status = 'waiting_approval'
              )`,
            ),
          )
          .returning({
            id: approvals.id,
            action: approvals.action,
            jobId: approvals.subjectId,
            workspaceId: approvals.workspaceId,
            organizationId: approvals.organizationId,
          });
        const audit = createAuditRepository(tx, clock);
        const systemActor = { type: "system" as const, id: "approval-sweeper" };
        for (const approval of closed) {
          await audit.append(
            {
              organizationId: approval.organizationId,
              workspaceId: approval.workspaceId,
              actor: systemActor,
            },
            {
              actor: actorRef(systemActor),
              action: "approval.expired",
              subjectType: "job",
              subjectId: approval.jobId,
              data: { approvalId: approval.id, action: approval.action },
            },
          );
        }
        // Driven by the job, not by the rows closed above: an approval can also be closed elsewhere (a
        // reviewer answering after expiry, opening a new request, a migration), which leaves the job parked
        // with nothing pending. Fail it when its latest approval expired and no request is still open. Only workflow
        // gate requests (empty scope key) count: connector requests carry no expiry and must not park the job.
        const failed = await tx
          .update(jobs)
          .set({
            status: "failed",
            finishedAt: now,
            updatedAt: now,
            error: sql`jsonb_build_object(
              'code', 'TIMEOUT',
              'message', (select l.action from ${approvals} l where l.id = (
                select max(m.id) from ${approvals} m
                where m.workspace_id = "jobs"."workspace_id" and m.subject_type = 'job' and m.subject_id = "jobs"."id"
                  and m.scope_key = ''
              )) || ' approval expired before a reviewer decided',
              'retryable', false,
              'suggestedAction', 'Submit the job again and ask a reviewer to approve it before the request expires.',
              'details', jsonb_build_object('reason', 'approval_expired')
            )`,
          })
          .where(
            and(
              eq(jobs.status, "waiting_approval"),
              sql`not exists (
                select 1 from ${approvals} p
                where p.workspace_id = "jobs"."workspace_id" and p.subject_type = 'job'
                  and p.subject_id = "jobs"."id" and p.status = 'pending' and p.scope_key = ''
              )`,
              sql`exists (
                select 1 from ${approvals} l
                where l.workspace_id = "jobs"."workspace_id" and l.subject_type = 'job'
                  and l.subject_id = "jobs"."id" and l.status = 'expired' and l.scope_key = ''
                  and l.id = (
                    select max(m.id) from ${approvals} m
                    where m.workspace_id = l.workspace_id and m.subject_type = 'job' and m.subject_id = l.subject_id
                      and m.scope_key = ''
                  )
              )`,
            ),
          )
          .returning({ id: jobs.id });
        return failed.length;
      });
    },
  };
}
