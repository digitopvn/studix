import { executionUsageDedupeKey, toBudgetCents, type UsageLedger, usageDedupeKey } from "@studix/billing";
import {
  type AgentHandoff,
  type AgentHandoffRepository,
  type AgentRuntime,
  type Approval,
  type ApprovalAction,
  type BillingPolicy,
  canClaimMediaJob,
  type Job,
  type JobRepository,
  type MediaJobJournal,
  type MediaJobRecord,
  type Stage,
  type StageCacheRepository,
  type TenantContext,
} from "@studix/core";
import { type Clock, type Logger, StudixError, toStudixError } from "@studix/shared";
import { AssetRef, contentDigest, type StoryboardReviewStatus } from "@studix/video-ir";
import { type ApprovalGateDeps, checkApprovalGate } from "./approval-gate.ts";
import { StageFailedAfterSpend, StageSuspended } from "./stage-signals.ts";
import type { WorkerJobQueue } from "./worker-job-queue.ts";
import type {
  AgentStageServices,
  MediaOutputCache,
  StageContext,
  StageDefinition,
  StageOutput,
  StageServices,
  StageUsage,
  WorkflowDefinition,
} from "./workflow-types.ts";

/** How the worker runs agent stages. Without it an agent stage fails UNAVAILABLE. */
export interface AgentStageWiring {
  handoffs: Pick<AgentHandoffRepository, "findLatest">;
  /** The in-worker agent runtime for one stage run; omitted or undefined means host mode only. */
  runtimeFor?(stage: StageContext): AgentRuntime | undefined;
}

/** Scope of the overrun approvals of an agent stage. */
export function agentOverrunScope(stage: string): string {
  return `agent:${stage}`;
}

export interface StageRunnerDeps extends ApprovalGateDeps {
  /** Source of stage reads; every write goes through the fenced `queue`. */
  jobs: JobRepository;
  queue: WorkerJobQueue;
  billing: BillingPolicy;
  ledger: UsageLedger;
  clock: Clock;
  logger: Logger;
  /** Minimum time between persisted in-stage progress updates. */
  progressIntervalMs?: number;
  /** How long a stage aborted by cancel, deadline or shutdown may take to report its spend (default 2000 ms). */
  abortGraceMs?: number;
  /** Tenant-wide memo of stage outputs by cacheKey; without it `cacheKey` is ignored. */
  stageCache?: StageCacheRepository;
  /**
   * Review status of a project's storyboard (core `storyboardStatus`). Stages that require an approved
   * storyboard fail closed when this is missing.
   */
  storyboardStatus?(ctx: TenantContext, projectId: string): Promise<StoryboardReviewStatus | undefined>;
  /** Ports handed to every stage as `StageContext.services`. */
  services?: StageServices;
  agents?: AgentStageWiring;
}

/**
 * The media job journal of one stage run. It starts from the records every earlier attempt of the stage
 * stored (the newest record per idempotency key wins) and persists each `put` through `persist`, which
 * writes the stage row fenced by job ownership. Writes are serialized so the stored list never goes
 * backwards; a refused write rejects the `put` (or `claim`), so a provider never reports a job it could not
 * journal.
 */
function stageMediaJournal(
  ctx: TenantContext,
  prior: readonly Stage[],
  persist: (records: MediaJobRecord[]) => Promise<void>,
): MediaJobJournal {
  const records = new Map<string, MediaJobRecord>();
  for (const row of prior) {
    for (const record of row.mediaJobs ?? []) {
      const known = records.get(record.idempotencyKey);
      if (!known || record.updatedAt >= known.updatedAt) records.set(record.idempotencyKey, record);
    }
  }
  const sameTenant = (c: TenantContext) =>
    c.workspaceId === ctx.workspaceId && c.organizationId === ctx.organizationId;
  let queue: Promise<void> = Promise.resolve();
  const foreign = () =>
    Promise.reject(
      new StudixError("FORBIDDEN", "media job journal belongs to another workspace", { retryable: false }),
    );
  const store = (record: MediaJobRecord): Promise<void> => {
    records.set(record.idempotencyKey, structuredClone(record));
    const write = queue.then(() => persist([...records.values()].map((r) => structuredClone(r))));
    queue = write.catch(() => undefined);
    return write;
  };
  return {
    async get(c, key) {
      if (!sameTenant(c)) return undefined;
      const record = records.get(key);
      return record ? structuredClone(record) : undefined;
    },
    put(c, record) {
      return sameTenant(c) ? store(record) : foreign();
    },
    claim(c, record) {
      if (!sameTenant(c)) return foreign();
      // Checked and set in one synchronous step; other workers are fenced out by the job lease.
      if (!canClaimMediaJob(records.get(record.idempotencyKey), record)) return Promise.resolve(false);
      return store(record).then(() => true);
    },
  };
}

/** Fail unless a person approved the job's storyboard; checked before any cache, gate or charge. */
async function assertStoryboardApproved(
  deps: StageRunnerDeps,
  ctx: TenantContext,
  job: Job,
  stage: StageDefinition,
): Promise<void> {
  const status =
    job.projectId && deps.storyboardStatus ? await deps.storyboardStatus(ctx, job.projectId) : undefined;
  if (status === "approved") return;
  throw new StageFailure(
    stage,
    new StudixError("APPROVAL_REQUIRED", `Stage ${stage.name} needs an approved storyboard`, {
      retryable: false,
      details: { stage: stage.name, projectId: job.projectId, storyboardStatus: status ?? "missing" },
      suggestedAction:
        "Ask a workspace member to approve the storyboard on the dashboard review page, then call studix_render.",
    }),
  );
}

export type StagesOutcome =
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "waiting_approval"; approval: Approval; stage: string }
  | { status: "waiting_host"; handoff: AgentHandoff; stage: string };

/** Error raised by a stage, tagged with the stage so the executor can apply its retry policy. */
export class StageFailure extends Error {
  constructor(
    readonly stage: StageDefinition,
    readonly error: StudixError,
  ) {
    super(error.message, { cause: error });
    this.name = "StageFailure";
  }
}

/** A fenced write was refused: another worker owns the job now, so this attempt must stop writing. */
export class LeaseLostError extends Error {
  constructor() {
    super("Job lease was lost to another worker");
    this.name = "LeaseLostError";
  }
}

/** Settle with the stage, or reject as soon as the signal aborts (a stuck stage cannot hold the worker). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** How long a stage aborted by cancel, deadline or shutdown may take to report the usage of its paid calls. */
const ABORT_GRACE_MS = 2000;

function leaseLost(signal: AbortSignal): boolean {
  return signal.reason instanceof StudixError && signal.reason.code === "CONFLICT";
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Remember how `work` settled; the returned promise never rejects. */
function trackSettled<T>(work: Promise<T>, onSettled: (s: Settled<T>) => void): Promise<void> {
  return work.then(
    (value) => onSettled({ ok: true, value }),
    (error: unknown) => onSettled({ ok: false, error }),
  );
}

/** Usage a stage reported, by returning it or by failing/suspending with it. */
function usageOfSettled(s: Settled<{ usage?: StageUsage[] }> | undefined): StageUsage[] {
  if (!s) return [];
  if (s.ok) return s.value?.usage ?? [];
  return s.error instanceof StageFailedAfterSpend || s.error instanceof StageSuspended ? s.error.usage : [];
}

/** Wait up to `graceMs` for an aborted stage to settle, then return the usage it reported (none if it never did). */
async function spendAfterAbort(
  running: Promise<unknown> | undefined,
  settledNow: () => Settled<{ usage?: StageUsage[] }> | undefined,
  graceMs: number,
): Promise<StageUsage[]> {
  if (running && !settledNow() && graceMs > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timer);
  }
  return usageOfSettled(settledNow());
}

/**
 * Cache key of a stage run: the stage, a version the stage bumps whenever its behavior changes, and the
 * digest of its canonical input.
 */
export function stageCacheKey(stage: string, version: string | number, input: unknown): string {
  return `${stage}@${version}:${contentDigest(input)}`;
}

/** Stage-cache namespace of paid media outputs; no pack stage may take this name. */
export const MEDIA_OUTPUT_CACHE_STAGE = "media-output";

/**
 * The tenant's paid media outputs, kept in the stage cache under their own namespace. An entry is written
 * only after its output is stored; an entry whose asset no longer parses is treated as absent.
 */
export function mediaOutputCache(
  cache: StageCacheRepository,
  ctx: TenantContext,
  jobId: string,
): MediaOutputCache {
  return {
    async get(key) {
      const hit = await cache.get(ctx, MEDIA_OUTPUT_CACHE_STAGE, key);
      const asset = AssetRef.safeParse(hit?.output.asset);
      if (!hit || !asset.success) return undefined;
      return { asset: asset.data, ...(hit.jobId ? { jobId: hit.jobId } : {}) };
    },
    async put(key, asset) {
      await cache.put(ctx, { stage: MEDIA_OUTPUT_CACHE_STAGE, cacheKey: key, output: { asset }, jobId });
    },
  };
}

/** Parse the stage input, or fail the stage before it runs. */
function parseInput(stage: StageDefinition, job: Job, outputs: Record<string, StageOutput>): unknown {
  if (!stage.inputSchema) return undefined;
  const parsed = stage.inputSchema.safeParse({ payload: job.payload, outputs });
  if (parsed.success) return parsed.data;
  throw new StageFailure(
    stage,
    new StudixError("VALIDATION", `Invalid input for stage ${stage.name}`, {
      retryable: false,
      details: { issues: parsed.error.issues.slice(0, 10) },
    }),
  );
}

function matchesOutput(stage: StageDefinition, output: StageOutput): boolean {
  return stage.outputSchema ? stage.outputSchema.safeParse(output).success : true;
}

/** Latest succeeded output per stage name (any attempt): the checkpoints a resumed job starts from. */
function checkpoints(stages: Stage[]): Record<string, StageOutput> {
  const done = new Map<string, { attempt: number; output: StageOutput }>();
  for (const s of stages) {
    if (s.status !== "succeeded") continue;
    const prev = done.get(s.name);
    if (!prev || s.attempt > prev.attempt) done.set(s.name, { attempt: s.attempt, output: s.output ?? {} });
  }
  return Object.fromEntries([...done].map(([name, v]) => [name, v.output]));
}

function budgetError(message: string, details: Record<string, unknown>): StudixError {
  return new StudixError("BUDGET_EXCEEDED", message, {
    retryable: false,
    details,
    suggestedAction: "Raise the job budget or simplify the brief, then submit a new job.",
  });
}

const APPROVAL_PAGE = 100;

/** Every request of one gate (action and scope) of the job, oldest first. */
async function gateHistory(
  deps: StageRunnerDeps,
  ctx: TenantContext,
  job: Job,
  action: ApprovalAction,
  scopeKey: string,
): Promise<Approval[]> {
  const subject = { type: "job" as const, id: job.id };
  const out: Approval[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.approvals.list(ctx, { subject, limit: APPROVAL_PAGE, cursor });
    out.push(...page.items.filter((a) => a.action === action && (a.scopeKey ?? "") === scopeKey));
    cursor = page.nextCursor;
  } while (cursor);
  // Pages run newest first.
  return out.reverse();
}

/** The agent services of one stage run, reading approvals and host tasks on every call (they survive restarts). */
function agentStageServices(
  deps: StageRunnerDeps,
  wiring: AgentStageWiring,
  ctx: TenantContext,
  job: Job,
  workerId: string,
  stageName: string,
  sctx: StageContext,
): AgentStageServices {
  const subject = { type: "job" as const, id: job.id };
  const scopeKey = agentOverrunScope(stageName);
  return {
    get runtime() {
      return wiring.runtimeFor?.(sctx);
    },
    latestHandoff: () => wiring.handoffs.findLatest(ctx, job.id, stageName),
    latestOverrun: () => deps.approvals.findLatest(ctx, subject, "agent.overrun", scopeKey),
    async grantedOverruns() {
      let granted = 0;
      let cursor: string | undefined;
      do {
        const page = await deps.approvals.list(ctx, { subject, limit: APPROVAL_PAGE, cursor });
        granted += page.items.filter(
          (a) =>
            a.action === "agent.overrun" &&
            (a.scopeKey ?? "") === scopeKey &&
            (a.status === "consumed" || (a.status === "approved" && a.decidedBy?.type === "user")),
        ).length;
        cursor = page.nextCursor;
      } while (cursor);
      return granted;
    },
    async consumeOverrun(approvalId) {
      if (!(await deps.queue.consumeApproval(job, workerId, approvalId))) throw new LeaseLostError();
    },
  };
}

/**
 * Run a workflow's stages for one claimed attempt. Completed stages are skipped using their checkpoint;
 * each executed stage is recorded in `stages`, its usage written idempotently to the ledger, and the
 * job budget enforced before (estimate) and after (actual spend) every stage.
 */
export async function runStages(
  deps: StageRunnerDeps,
  ctx: TenantContext,
  job: Job,
  workerId: string,
  workflow: WorkflowDefinition,
  signal: AbortSignal,
): Promise<StagesOutcome> {
  const { queue } = deps;
  const fenced = async (write: Promise<boolean>): Promise<void> => {
    if (!(await write)) throw new LeaseLostError();
  };
  const route = workflow.route?.(job) ?? workflow;
  const rows = await deps.jobs.listStages(ctx, job.id);
  const saved = checkpoints(rows);
  const outputs: Record<string, StageOutput> = {};
  let spentCents = job.spentCents;
  const total = route.stages.length;
  const services = deps.services ?? {};

  for (const [index, stage] of route.stages.entries()) {
    signal.throwIfAborted();
    const checkpoint = saved[stage.name];
    if (checkpoint && ((await stage.isCheckpointValid?.(checkpoint, saved)) ?? true)) {
      outputs[stage.name] = checkpoint;
      continue;
    }

    let lastProgressAt = 0;
    let startedAt = deps.clock.now();
    const mediaJournal = stageMediaJournal(
      ctx,
      rows.filter((r) => r.name === stage.name),
      (mediaJobs) =>
        fenced(
          queue.writeStage(job, workerId, { name: stage.name, status: "running", startedAt, mediaJobs }),
        ),
    );
    const sctx: StageContext = {
      ctx,
      job,
      attempt: job.attempts,
      signal,
      outputs,
      input: parseInput(stage, job, outputs),
      commit: async (write) => {
        signal.throwIfAborted();
        const result = await queue.commit(job, workerId, write);
        if (!result.held) throw new LeaseLostError();
        return result.value;
      },
      reportProgress: (p) => {
        const now = deps.clock.now().getTime();
        if (now - lastProgressAt < (deps.progressIntervalMs ?? 1000)) return;
        lastProgressAt = now;
        const progress = (index + Math.min(Math.max(p, 0), 1)) / total;
        queue
          .updateProgress(job, workerId, { progress })
          .then((held) => {
            if (!held) deps.logger.warn("progress dropped, job lease lost", { jobId: job.id });
          })
          .catch((err) => {
            deps.logger.warn("progress update failed", { jobId: job.id, error: String(err) });
          });
      },
      mediaJournal,
      ...(deps.stageCache ? { mediaOutputs: mediaOutputCache(deps.stageCache, ctx, job.id) } : {}),
      services,
    };

    if (stage.requiresApprovedStoryboard) await assertStoryboardApproved(deps, ctx, job, stage);
    if (deps.agents)
      sctx.agents = agentStageServices(deps, deps.agents, ctx, job, workerId, stage.name, sctx);

    // A cached result of the same work is reused before any gate, budget check or charge.
    const cacheKey = deps.stageCache ? await stage.cacheKey?.(sctx) : undefined;
    if (cacheKey !== undefined && deps.stageCache) {
      const hit = await deps.stageCache.get(ctx, stage.name, cacheKey);
      if (hit && matchesOutput(stage, hit.output)) {
        const at = deps.clock.now();
        await fenced(
          queue.writeStage(job, workerId, {
            name: stage.name,
            status: "succeeded",
            output: hit.output,
            startedAt: at,
            finishedAt: at,
          }),
        );
        outputs[stage.name] = hit.output;
        continue;
      }
    }

    if (stage.approval) {
      const gate = await checkApprovalGate(deps, ctx, job, workerId, {
        action: stage.approval.action,
        estimatedCostCents: stage.approval.estimateCostCents?.(job),
        ...(stage.approval.scopeKey ? { scopeKey: stage.approval.scopeKey } : {}),
        ...(stage.approval.reason ? { reason: stage.approval.reason } : {}),
      });
      if (gate.status === "lease_lost") throw new LeaseLostError();
      if (gate.status === "waiting")
        return { status: "waiting_approval", approval: gate.approval, stage: stage.name };
      sctx.approval = gate.approval;
      if (stage.approval.scopeKey !== undefined)
        sctx.approvalHistory = await gateHistory(
          deps,
          ctx,
          job,
          stage.approval.action,
          stage.approval.scopeKey,
        );
    }

    const estimate = (await stage.estimateCostCents?.(sctx)) ?? 0;
    const decision = await deps.billing.authorizeSpend(ctx, {
      jobId: job.id,
      purpose: stage.name,
      estimatedCostCents: estimate,
      budgetCents: job.budgetCents,
      spentCents,
    });
    if (!decision.allowed) {
      if (decision.code === "BUDGET_EXCEEDED")
        throw budgetError(decision.reason, { stage: stage.name, estimate, spentCents });
      throw new StudixError(decision.code, decision.reason, {
        retryable: false,
        details: { stage: stage.name },
      });
    }

    startedAt = deps.clock.now();
    await fenced(queue.updateProgress(job, workerId, { stage: stage.name, progress: index / total }));
    await fenced(queue.writeStage(job, workerId, { name: stage.name, status: "running", startedAt }));
    const recordUsage = async (lines: readonly StageUsage[]) => {
      for (const usage of lines) {
        await fenced(
          queue.recordUsage(job, workerId, {
            // A usage line tied to a provider execution is that one call's cost, whatever attempt reports
            // it (e.g. a retry served from the decision cache); anything else re-ran and cost again.
            dedupeKey:
              (usage.providerExecutionId ?? usage.upstreamJob)
                ? executionUsageDedupeKey({
                    jobId: job.id,
                    stage: stage.name,
                    executionId: (usage.providerExecutionId ?? usage.upstreamJob) as string,
                  })
                : usageDedupeKey({
                    jobId: job.id,
                    stage: stage.name,
                    attempt: job.attempts,
                    item: usage.item,
                  }),
            kind: usage.kind,
            quantity: usage.quantity,
            unit: usage.unit,
            costCents: usage.costCents,
            jobId: job.id,
            providerExecutionId: usage.providerExecutionId,
            metadata: { ...usage.metadata, stage: stage.name, attempt: job.attempts },
          }),
        );
      }
    };

    // Park the job instead of failing it: what the stage spent is billed, then the request is opened.
    const suspend = async (signalled: StageSuspended): Promise<StagesOutcome> => {
      await recordUsage(signalled.usage);
      if (signalled.usage.length > 0) {
        spentCents = toBudgetCents(await deps.ledger.jobCostCents(ctx, job.id));
        await fenced(queue.updateProgress(job, workerId, { spentCents }));
      }
      await fenced(queue.writeStage(job, workerId, { name: stage.name, status: "pending", startedAt }));
      const s = signalled.suspension;
      if (s.kind === "approval") {
        const opened = await queue.requestApproval(job, workerId, {
          action: s.action,
          reason: s.reason,
          estimatedCostCents: s.estimatedCostCents,
          ttlMs: deps.approvalTtlMs,
          scopeKey: s.scopeKey,
        });
        if (opened.status === "lost") throw new LeaseLostError();
        return { status: "waiting_approval", approval: opened.approval, stage: stage.name };
      }
      const opened = await queue.openHandoff(job, workerId, {
        ...s.task,
        stage: stage.name,
        expiresAt: new Date(deps.clock.now().getTime() + s.task.limits.timeoutMs),
      });
      if (opened.status === "lost") throw new LeaseLostError();
      return { status: "waiting_host", handoff: opened.handoff, stage: stage.name };
    };

    let output: StageOutput;
    // What the stage settled with, even after the runner stopped waiting for it on abort.
    let settled: Settled<Awaited<ReturnType<typeof stage.run>>> | undefined;
    let running: Promise<unknown> | undefined;
    try {
      const work = stage.run(sctx);
      running = trackSettled(work, (s) => {
        settled = s;
      });
      const result = await untilAborted(work, signal);
      // Bill first: the stage's calls are paid whether or not the output is still wanted.
      await recordUsage(result.usage ?? []);
      signal.throwIfAborted();
      output = result.output;
      if (!matchesOutput(stage, output)) {
        throw new StudixError("VALIDATION", `Stage ${stage.name} returned an output that fails its schema`, {
          retryable: false,
        });
      }
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      if (err instanceof StageSuspended && !signal.aborted) return await suspend(err);
      // On cancel or deadline the runner stopped waiting, but paid calls already made still bill the job:
      // give the stage a bounded moment to settle, then record the usage it reports.
      // A lost lease (CONFLICT) skips the wait: the fenced writes would be refused anyway.
      const spent = signal.aborted
        ? await spendAfterAbort(
            running,
            () => settled,
            leaseLost(signal) ? 0 : (deps.abortGraceMs ?? ABORT_GRACE_MS),
          )
        : err instanceof StageFailedAfterSpend
          ? err.usage
          : [];
      if (spent.length > 0) {
        try {
          await recordUsage(spent);
          // Keep the job's counter on the ledger, so the dashboard and a retry's budget check see the spend.
          spentCents = toBudgetCents(await deps.ledger.jobCostCents(ctx, job.id));
          await fenced(queue.updateProgress(job, workerId, { spentCents }));
        } catch (usageErr) {
          if (usageErr instanceof LeaseLostError) throw usageErr;
          deps.logger.warn("spend of a failed stage could not be recorded", {
            jobId: job.id,
            error: String(usageErr),
          });
        }
      }
      const reason: unknown = signal.aborted
        ? signal.reason
        : err instanceof StageFailedAfterSpend
          ? err.error
          : err;
      const error = toStudixError(reason);
      try {
        await fenced(
          queue.writeStage(job, workerId, {
            name: stage.name,
            status: error.code === "CANCELLED" ? "cancelled" : "failed",
            error: error.toJSON(),
            startedAt,
            finishedAt: deps.clock.now(),
          }),
        );
      } catch (writeErr) {
        if (writeErr instanceof LeaseLostError) throw writeErr;
        // Keep the stage's own failure so its retry policy (e.g. publish: never) still applies.
        deps.logger.warn("failed stage row could not be written", { jobId: job.id, error: String(writeErr) });
      }
      throw new StageFailure(stage, error);
    }

    spentCents = toBudgetCents(await deps.ledger.jobCostCents(ctx, job.id));
    await fenced(queue.updateProgress(job, workerId, { spentCents, progress: (index + 1) / total }));
    await fenced(
      queue.writeStage(job, workerId, {
        name: stage.name,
        status: "succeeded",
        output,
        startedAt,
        finishedAt: deps.clock.now(),
      }),
    );
    outputs[stage.name] = output;
    // After the fenced checkpoint, so a worker that lost the job never publishes its result to the cache.
    if (cacheKey !== undefined && deps.stageCache) {
      await deps.stageCache.put(ctx, { stage: stage.name, cacheKey, output, jobId: job.id });
    }
    if (job.budgetCents !== undefined && spentCents > job.budgetCents) {
      throw budgetError(
        `job spent ${spentCents}¢, over its ${job.budgetCents}¢ budget, after ${stage.name}`,
        {
          stage: stage.name,
          spentCents,
          budgetCents: job.budgetCents,
        },
      );
    }
  }
  return { status: "succeeded", result: route.result(outputs) };
}
