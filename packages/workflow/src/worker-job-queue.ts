import { createUsageLedger, type UsageInput } from "@studix/billing";
import {
  type AgentHandoff,
  type Approval,
  type ApprovalAction,
  actorRef,
  type Job,
  type JobPatch,
  type NewAgentHandoff,
  type ProjectRepository,
  type RenderRepository,
  type TenantContext,
} from "@studix/core";
import {
  createAgentHandoffRepository,
  createApprovalRepository,
  createAuditRepository,
  createProjectRepository,
  createRenderRepository,
  createUsageRepository,
  type DbExecutor,
  type StudixDb,
  schema,
  toJob,
  upsertStageRow,
} from "@studix/database";
import { type Clock, type StudixErrorPayload, storableJson, systemClock } from "@studix/shared";
import { and, asc, eq, inArray, lt, lte, ne, or, type SQL, sql } from "drizzle-orm";

const { jobs, approvals, stages, agentHandoffs } = schema;
/** The approval request a parked job waits on. */
export interface ParkedRequest {
  action: ApprovalAction;
  scopeKey: string;
}

/**
 * SQL for "approval row `alias` is a request the parked job waits on". A job the worker parked records the
 * request it waits on, and only that one counts: another pending request on the same job (a render approval
 * the studio opened, say) must not hold it. A job without a record, parked by the studio service, falls
 * back to the scope-key convention: workflow gates (empty scope key), agent overrun (`agent:<stage>`) and
 * creative gates (`gate:<id>`). Outer columns carry the table name: unqualified names would bind to the
 * inner alias.
 */
const gatingRequest = (alias: string): SQL => {
  const a = sql.raw(alias);
  return sql`(case when "jobs"."parked_action" is not null
    then ${a}.action = "jobs"."parked_action" and ${a}.scope_key = "jobs"."parked_scope_key"
    else ${a}.scope_key = '' or ${a}.scope_key like 'agent:%' or ${a}.scope_key like 'gate:%' end)`;
};

type JobSet = Partial<typeof jobs.$inferInsert>;

/** Which jobs a claim may take. */
export interface ClaimOptions {
  /** Leave out jobs that hold a slot for a long agent run (the `skill-agent` workflow template). */
  skipLongAgentJobs?: boolean;
}

/** A gated action's pending approval request, opened on behalf of a claimed attempt. */
export interface ApprovalRequest {
  action: ApprovalAction;
  reason: string;
  estimatedCostCents?: number;
  /** Lifetime of a newly opened request. */
  ttlMs: number;
  /**
   * Scope of the request (`""`, the default, is the stage gate of the action). Besides it the worker uses
   * `agent:<stage>` (agent overruns) and `gate:<id>` (creative gates); all of them park the job and expire.
   */
  scopeKey?: string;
}

/** A host-agent task opened for the attempt; `lost` means this worker no longer owns the job. */
export type HandoffOpenResult =
  | { status: "lost" }
  | { status: "created" | "existing"; handoff: AgentHandoff };

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

/** Business repositories bound to the transaction of a fenced commit. */
export interface FencedRepositories {
  projects: ProjectRepository;
  renders: RenderRepository;
}

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
  claim(workerId: string, options?: ClaimOptions): Promise<Job | undefined>;
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
  /**
   * Spend a human-approved request (approved -> consumed) and audit it, fenced like the writes above.
   * Returns false when this worker lost the job; a request that is no longer approved is left alone.
   */
  consumeApproval(job: Job, workerId: string, approvalId: string): Promise<boolean>;
  /**
   * Open the host-agent task of a stage for this attempt, fenced like the writes above. The live pending
   * task of the same attempt is reused; one left by an earlier attempt is cancelled first, since only the
   * attempt that parks the job can be answered.
   */
  openHandoff(
    job: Job,
    workerId: string,
    handoff: Omit<NewAgentHandoff, "jobId" | "attempt">,
  ): Promise<HandoffOpenResult>;
  /**
   * Run business writes (projects, renders) in one transaction that holds the job row locked after the
   * same ownership check. Nothing is written, and `held` is false, once another worker owns the job; a
   * throw from `write` rolls the whole commit back.
   */
  commit<T>(
    job: Job,
    workerId: string,
    write: (repos: FencedRepositories, ctx: TenantContext) => Promise<T>,
  ): Promise<{ held: true; value: T } | { held: false }>;
  complete(job: Job, workerId: string, result: Record<string, unknown>): Promise<boolean>;
  fail(job: Job, workerId: string, error: StudixErrorPayload): Promise<boolean>;
  cancel(job: Job, workerId: string, error: StudixErrorPayload): Promise<boolean>;
  /** Requeue after a retryable failure; the attempt stays counted. */
  retry(job: Job, workerId: string, error: StudixErrorPayload, runAfter: Date): Promise<boolean>;
  /** Give the job back without consuming the attempt (graceful shutdown). */
  release(job: Job, workerId: string): Promise<boolean>;
  /** Park in waiting_approval without consuming the attempt; resumed by resumeDecidedApprovals. */
  park(job: Job, workerId: string, waitingOn?: ParkedRequest): Promise<boolean>;
  /** Park in waiting_host without consuming the attempt; resumed by an accepted host submission. */
  parkForHost(job: Job, workerId: string): Promise<boolean>;
  /**
   * Expire pending host-agent tasks past their time limit whose job is parked in waiting_host, and requeue
   * those jobs so the stage asks a person for more time. Returns the number of tasks expired.
   */
  expireHostHandoffs(): Promise<number>;
  /** Fail running jobs whose lease expired after their last allowed attempt. Returns the count. */
  failExhaustedLeases(): Promise<number>;
  /**
   * Requeue jobs parked by the worker whose latest gating approval (any action except job.start, which
   * the studio service resumes itself) was granted by a human, rejected, or sent back with changes (the
   * creative gate redoes them and asks again). Returns the count.
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

  /** Run `write` in a transaction that holds the job row locked while ownership is verified. */
  const fencedValue = async <T>(
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
  ): Promise<boolean> => (await fencedValue(job, workerId, write)).held;

  const requestApproval: WorkerJobQueue["requestApproval"] = async (job, workerId, request) => {
    let result: ApprovalRequestResult = { status: "lost" };
    const held = await fenced(job, workerId, async (tx, ctx) => {
      const approvalRepo = createApprovalRepository(tx, clock);
      const subject = { type: "job" as const, id: job.id };
      const scopeKey = request.scopeKey ?? "";
      const latest = await approvalRepo.findLatest(ctx, subject, request.action, scopeKey);
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
        ...(scopeKey ? { scopeKey } : {}),
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
        data: { approvalId: approval.id, action: request.action, reason: request.reason, scopeKey },
      });
      result = { status: "created", approval };
    });
    return held ? result : { status: "lost" };
  };

  /** Pause the deadline while parked: keep what is left of it and clear the absolute time. */
  const pausedDeadline = (job: Job): Pick<JobSet, "deadlineAt" | "deadlineRemainingMs"> =>
    job.deadlineAt
      ? {
          deadlineAt: null,
          deadlineRemainingMs: Math.max(0, job.deadlineAt.getTime() - clock.now().getTime()),
        }
      : {};

  const finish = async (job: Job, workerId: string, set: JobSet): Promise<boolean> => {
    const rows = await db
      .update(jobs)
      .set({
        ...set,
        // A failure message can quote agent output; text Postgres cannot store would lose the outcome.
        ...(set.error ? { error: storableJson(set.error) } : {}),
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: clock.now(),
      })
      .where(owned(job, workerId))
      .returning({ id: jobs.id });
    return rows.length === 1;
  };

  return {
    leaseMs: options.leaseMs,

    async claim(workerId, claimOptions = {}) {
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
            claimOptions.skipLongAgentJobs
              ? // A job on an existing version only plans, renders and uploads: it is not a long agent run.
                sql`(coalesce(${jobs.payload}->>'workflowTemplate', '') <> 'skill-agent' or ${jobs.payload}->>'versionId' is not null)`
              : undefined,
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
          parkedAction: null,
          parkedScopeKey: null,
          startedAt: sql`coalesce(${jobs.startedAt}, ${now.toISOString()}::timestamptz)`,
          // Re-arm a deadline that was paused while the job waited at a gate or for the host agent.
          deadlineAt: sql`case when ${jobs.deadlineRemainingMs} is not null
            then ${now.toISOString()}::timestamptz + ${jobs.deadlineRemainingMs} * interval '1 millisecond'
            else ${jobs.deadlineAt} end`,
          deadlineRemainingMs: null,
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

    async consumeApproval(job, workerId, approvalId) {
      return fenced(job, workerId, async (tx, ctx) => {
        if (!(await createApprovalRepository(tx, clock).consume(ctx, approvalId))) return;
        await createAuditRepository(tx, clock).append(ctx, {
          actor: actorRef(ctx.actor),
          action: "approval.consumed",
          subjectType: "job",
          subjectId: job.id,
          data: { approvalId },
        });
      });
    },

    async openHandoff(job, workerId, handoff) {
      const result = await fencedValue(job, workerId, async (tx, ctx) => {
        const now = clock.now();
        // A task left pending by an earlier attempt can no longer be submitted: close it.
        await tx
          .update(agentHandoffs)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              eq(agentHandoffs.jobId, job.id),
              eq(agentHandoffs.stage, handoff.stage),
              eq(agentHandoffs.status, "pending"),
              ne(agentHandoffs.attempt, job.attempts),
            ),
          );
        const opened = await createAgentHandoffRepository(tx, clock).open(ctx, {
          ...handoff,
          jobId: job.id,
          attempt: job.attempts,
        });
        if (opened.created) {
          await createAuditRepository(tx, clock).append(ctx, {
            actor: actorRef(ctx.actor),
            action: "agent_task.opened",
            subjectType: "job",
            subjectId: job.id,
            data: {
              taskId: opened.handoff.id,
              stage: handoff.stage,
              attempt: job.attempts,
              round: handoff.round,
            },
          });
        }
        return opened;
      });
      if (!result.held) return { status: "lost" };
      return { status: result.value.created ? "created" : "existing", handoff: result.value.handoff };
    },

    commit: (job, workerId, write) =>
      fencedValue(job, workerId, (tx, ctx) =>
        write(
          { projects: createProjectRepository(tx, clock), renders: createRenderRepository(tx, clock) },
          ctx,
        ),
      ),

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
    park: (job, workerId, waitingOn) =>
      finish(job, workerId, {
        status: "waiting_approval",
        parkedAction: waitingOn?.action ?? null,
        parkedScopeKey: waitingOn?.scopeKey ?? null,
        attempts: job.attempts - 1,
        ...pausedDeadline(job),
      }),
    parkForHost: (job, workerId) =>
      finish(job, workerId, { status: "waiting_host", attempts: job.attempts - 1, ...pausedDeadline(job) }),

    async expireHostHandoffs() {
      const now = clock.now();
      return db.transaction(async (tx) => {
        const expired = await tx
          .update(agentHandoffs)
          .set({ status: "expired", updatedAt: now })
          .where(
            and(
              eq(agentHandoffs.status, "pending"),
              lte(agentHandoffs.expiresAt, now),
              sql`exists (
                select 1 from ${jobs} j
                where j.id = ${agentHandoffs.jobId} and j.workspace_id = ${agentHandoffs.workspaceId}
                  and j.organization_id = ${agentHandoffs.organizationId} and j.status = 'waiting_host'
              )`,
            ),
          )
          .returning({
            id: agentHandoffs.id,
            jobId: agentHandoffs.jobId,
            stage: agentHandoffs.stage,
            workspaceId: agentHandoffs.workspaceId,
            organizationId: agentHandoffs.organizationId,
          });
        if (expired.length === 0) return 0;
        // The stage runs again, finds its task expired and asks a person whether it gets more time.
        await tx
          .update(jobs)
          .set({ status: "queued", runAfter: now, updatedAt: now })
          .where(
            and(
              inArray(
                jobs.id,
                expired.map((e) => e.jobId),
              ),
              eq(jobs.status, "waiting_host"),
            ),
          );
        const audit = createAuditRepository(tx, clock);
        const systemActor = { type: "system" as const, id: "handoff-sweeper" };
        for (const task of expired) {
          await audit.append(
            { organizationId: task.organizationId, workspaceId: task.workspaceId, actor: systemActor },
            {
              actor: actorRef(systemActor),
              action: "agent_task.expired",
              subjectType: "job",
              subjectId: task.jobId,
              data: { taskId: task.id, stage: task.stage },
            },
          );
        }
        return expired.length;
      });
    },

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
            // A job still waiting on its gating request (workflow gate, agent overrun, creative gate) stays
            // parked: running it again would only reach the same open request, after paying for the work
            // in front of it.
            sql`not exists (
              select 1 from ${approvals} p
              where p.workspace_id = "jobs"."workspace_id" and p.subject_type = 'job'
                and p.subject_id = "jobs"."id" and p.status = 'pending'
                and ${gatingRequest("p")}
            )`,
            // A decision only resumes the job while it is the latest answer for its own request, that is
            // for the same action and scope key.
            sql`exists (
              select 1 from ${approvals} a
              where a.workspace_id = "jobs"."workspace_id"
                and a.organization_id = "jobs"."organization_id"
                and a.subject_type = 'job'
                and a.subject_id = "jobs"."id"
                and a.action <> 'job.start'
                and ((a.status = 'approved' and a.decided_by_type = 'user') or a.status in ('rejected', 'changes_requested'))
                and a.id = (
                  select max(b.id) from ${approvals} b
                  where b.workspace_id = a.workspace_id and b.subject_type = 'job'
                    and b.subject_id = a.subject_id and b.action = a.action and b.scope_key = a.scope_key
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
        // with nothing pending. Fail it when its latest gating approval expired and no gating request is still
        // open: connector requests carry no expiry and must not park the job.
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
                  and ${gatingRequest("m")}
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
                  and p.subject_id = "jobs"."id" and p.status = 'pending' and ${gatingRequest("p")}
              )`,
              sql`exists (
                select 1 from ${approvals} l
                where l.workspace_id = "jobs"."workspace_id" and l.subject_type = 'job'
                  and l.subject_id = "jobs"."id" and l.status = 'expired' and ${gatingRequest("l")}
                  and l.id = (
                    select max(m.id) from ${approvals} m
                    where m.workspace_id = l.workspace_id and m.subject_type = 'job' and m.subject_id = l.subject_id
                      and ${gatingRequest("m")}
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
