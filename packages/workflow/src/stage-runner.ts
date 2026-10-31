import { toBudgetCents, type UsageLedger, usageDedupeKey } from "@studix/billing";
import type { Approval, BillingPolicy, Job, JobRepository, Stage, TenantContext } from "@studix/core";
import { type Clock, type Logger, StudixError, toStudixError } from "@studix/shared";
import { type ApprovalGateDeps, checkApprovalGate } from "./approval-gate.ts";
import type { WorkerJobQueue } from "./worker-job-queue.ts";
import type { StageContext, StageDefinition, StageOutput, WorkflowDefinition } from "./workflow-types.ts";

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
}

export type StagesOutcome =
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "waiting_approval"; approval: Approval; stage: string };

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
  const saved = checkpoints(await deps.jobs.listStages(ctx, job.id));
  const outputs: Record<string, StageOutput> = {};
  let spentCents = job.spentCents;
  const total = workflow.stages.length;

  for (const [index, stage] of workflow.stages.entries()) {
    signal.throwIfAborted();
    const checkpoint = saved[stage.name];
    if (checkpoint && ((await stage.isCheckpointValid?.(checkpoint, saved)) ?? true)) {
      outputs[stage.name] = checkpoint;
      continue;
    }

    let lastProgressAt = 0;
    const sctx: StageContext = {
      ctx,
      job,
      attempt: job.attempts,
      signal,
      outputs,
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
    };

    if (stage.approval) {
      const gate = await checkApprovalGate(deps, ctx, job, {
        action: stage.approval.action,
        estimatedCostCents: stage.approval.estimateCostCents?.(job),
      });
      if (gate.status === "waiting")
        return { status: "waiting_approval", approval: gate.approval, stage: stage.name };
      sctx.approval = gate.approval;
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

    const startedAt = deps.clock.now();
    await fenced(queue.updateProgress(job, workerId, { stage: stage.name, progress: index / total }));
    await fenced(queue.writeStage(job, workerId, { name: stage.name, status: "running", startedAt }));
    let output: StageOutput;
    try {
      const result = await untilAborted(stage.run(sctx), signal);
      signal.throwIfAborted();
      output = result.output;
      for (const usage of result.usage ?? []) {
        await fenced(
          queue.recordUsage(job, workerId, {
            dedupeKey: usageDedupeKey({
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
    } catch (err) {
      const reason: unknown = signal.aborted ? signal.reason : err;
      const error = toStudixError(reason);
      if (err instanceof LeaseLostError) throw err;
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
  return { status: "succeeded", result: workflow.result(outputs) };
}
