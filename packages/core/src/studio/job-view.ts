import { STAGE_STALL_MS, stageIdleMs } from "../entities/agent-trace.ts";
import { JOB_KINDS, type Job, type Stage } from "../entities/job.ts";
import { jobAgent } from "../entities/job-agent.ts";
import type { Approval } from "../entities/review.ts";
import type { UsageEvent } from "../entities/telemetry.ts";
import type { JobQueueLoad } from "../repositories/job-repository.ts";
import { AGENT_HANDOFF_TOOLS } from "./agent-handoff-service.ts";
import { stageRunOf } from "./stage-run.ts";
import {
  type ApprovalView,
  type JobQueueView,
  type JobView,
  type NextAction,
  STUDIX_TOOLS,
  type StageReviewView,
} from "./studio-types.ts";

export const JOB_POLL_INTERVAL_MS = 3000;

export function toApprovalView(approval: Approval): ApprovalView {
  return {
    id: approval.id,
    action: approval.action,
    status: approval.status,
    reason: approval.reason,
    subjectType: approval.subject.type,
    subjectId: approval.subject.id,
    expiresAt: approval.expiresAt,
  };
}

/** A hint to read the trace of a running stage that went quiet, ahead of the usual polling hint. */
function stallHints(job: Job, stalled: readonly { name: string; idleMs: number }[]): NextAction[] {
  return stalled.map((s) => ({
    tool: STUDIX_TOOLS.jobTrace,
    arguments: { jobId: job.id, stage: s.name },
    reason: `Warning: stage ${s.name} has shown no activity for ${Math.round(s.idleMs / 60_000)} min and may be stalled (hung, or one long tool call). Read its trace for the last steps before cancelling or retrying.`,
  }));
}

/** Next-action hints derived from job state; `stalled` lists running stages that went quiet. */
export function nextActionsForJob(
  job: Job,
  approval?: Approval,
  stalled: readonly { name: string; idleMs: number }[] = [],
): NextAction[] {
  switch (job.status) {
    case "queued":
    case "running":
      return [
        ...(job.status === "running" ? stallHints(job, stalled) : []),
        {
          tool: STUDIX_TOOLS.getJob,
          arguments: { jobId: job.id },
          reason:
            job.status === "queued"
              ? "Job is queued; poll for progress."
              : `Job is running (${job.stage ?? "starting"}).`,
          pollAfterMs: JOB_POLL_INTERVAL_MS,
        },
      ];
    case "waiting_approval":
      return approval?.status === "pending"
        ? [
            {
              // Only a signed-in person can decide, so an agent waits; it cannot approve for itself.
              tool: STUDIX_TOOLS.getJob,
              arguments: { jobId: job.id },
              reason: `Waiting for a workspace member to approve in the Studix dashboard: ${approval.reason}`,
              pollAfterMs: JOB_POLL_INTERVAL_MS,
            },
          ]
        : [];
    case "waiting_host":
      return [
        {
          tool: AGENT_HANDOFF_TOOLS.list,
          arguments: { jobId: job.id },
          reason: `Stage ${job.stage ?? "?"} waits for the host agent: fetch the task, do it and submit the output.`,
        },
      ];
    case "succeeded":
      return job.projectId
        ? [
            {
              tool: STUDIX_TOOLS.getProject,
              arguments: { projectId: job.projectId },
              reason: "Job finished; fetch the project for preview URLs and versions.",
            },
          ]
        : [];
    case "failed": {
      const hints: NextAction[] = [];
      if (job.kind !== JOB_KINDS.publish) {
        hints.push({
          tool: STUDIX_TOOLS.retryJob,
          arguments: { jobId: job.id },
          reason:
            "After the cause is fixed, resume this job: finished stages and paid media calls are reused, not paid again.",
        });
      }
      if (job.projectId) {
        hints.push({
          tool: STUDIX_TOOLS.getProject,
          arguments: { projectId: job.projectId },
          reason: job.error?.suggestedAction ?? "Inspect the project and its last version before retrying.",
        });
      }
      return hints;
    }
    case "cancelled":
      return [];
  }
}

/** A stage output of `{ source: "template", fallbackReason }` means the agent did not run; surface why. */
function fallbackOf(stage: Stage): { fallback?: string } {
  const out = stage.output;
  if (out?.source !== "template") return {};
  return { fallback: typeof out.fallbackReason === "string" ? out.fallbackReason : "agent unavailable" };
}

/** A stage output's `warning`: an optional part the stage skipped instead of failing the job. */
function warningOf(stage: Stage): { warning?: string } {
  const warning = stage.output?.warning;
  return typeof warning === "string" && warning !== "" ? { warning } : {};
}

/** QA rounds of a reviewed agent stage (skill-agent roles): each round's scores, verdict and notes. */
function reviewOf(stage: Stage): { review?: StageReviewView } {
  const review = (stage.output as { review?: { rounds?: unknown } } | undefined)?.review;
  return Array.isArray(review?.rounds)
    ? { review: { rounds: review.rounds as StageReviewView["rounds"] } }
    : {};
}

/** Usage lines of the job and labels of the connections they name, for each stage's runtime and cost. */
export interface JobSpendDetail {
  usage: readonly UsageEvent[];
  connectionLabels: ReadonlyMap<string, string>;
}

function stageRun(s: Stage, spend: JobSpendDetail | undefined) {
  if (!spend) return {};
  const run = stageRunOf(s, spend.usage);
  // A running stage books its spend when it ends; until then the live agent stream is the source.
  if (s.status === "running" && run.costCents === 0 && run.runtime === "function") return {};
  const label = run.connectionId ? spend.connectionLabels.get(run.connectionId) : undefined;
  const { connectionId: _id, ...shown } = run;
  return { run: { ...shown, ...(label ? { connectionLabel: label } : {}) } };
}

/** The wait reason of a queued job: behind other work, or between retries. */
export function toQueueView(job: Job, load: JobQueueLoad, now: Date): JobQueueView | undefined {
  if (job.status !== "queued") return undefined;
  if (job.runAfter > now) {
    return {
      running: load.running,
      reason: `Waiting for its scheduled start at ${job.runAfter.toISOString()}.`,
    };
  }
  const position = load.ahead + 1;
  const slots = load.running === 1 ? "1 job holds" : `${load.running} jobs hold`;
  return {
    position,
    running: load.running,
    reason:
      load.running > 0
        ? `Queued at position ${position}: ${slots} the worker slots and the job starts when one frees up. A long agent job can hold a slot for up to its deadline.`
        : `Queued at position ${position}: a worker claims it within seconds.`,
  };
}

export function toJobView(
  job: Job,
  stages: Stage[],
  approval?: Approval,
  spend?: JobSpendDetail,
  queue?: JobQueueView,
  now: Date = new Date(),
): JobView {
  const stalled = stages.flatMap((s) => {
    const idleMs = stageIdleMs(s, now);
    return idleMs !== undefined && idleMs >= STAGE_STALL_MS ? [{ name: s.name, idleMs }] : [];
  });
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    projectId: job.projectId,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    cancelRequested: job.cancelRequested,
    budget: { limitCents: job.budgetCents, spentCents: job.spentCents },
    deadlineAt: job.deadlineAt,
    deadlineRemainingMs: job.deadlineRemainingMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result,
    error: job.error,
    stages: stages.map((s) => ({
      name: s.name,
      status: s.status,
      attempt: s.attempt,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      error: s.error,
      ...fallbackOf(s),
      ...warningOf(s),
      ...reviewOf(s),
      ...stageRun(s, spend),
      ...(s.lastActivityAt ? { lastActivityAt: s.lastActivityAt } : {}),
      ...(stalled.some((x) => x.name === s.name) && s.status === "running" ? { stalled: true } : {}),
    })),
    approval: approval ? toApprovalView(approval) : undefined,
    agent: jobAgent(job),
    ...(queue ? { queue } : {}),
    next: nextActionsForJob(job, approval, stalled),
  };
}
