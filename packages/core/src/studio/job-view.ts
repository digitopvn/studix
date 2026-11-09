import { JOB_KINDS, type Job, type Stage } from "../entities/job.ts";
import { jobAgent } from "../entities/job-agent.ts";
import type { Approval } from "../entities/review.ts";
import type { UsageEvent } from "../entities/telemetry.ts";
import { AGENT_HANDOFF_TOOLS } from "./agent-handoff-service.ts";
import { stageRunOf } from "./stage-run.ts";
import {
  type ApprovalView,
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

/** Next-action hints derived from job state. */
export function nextActionsForJob(job: Job, approval?: Approval): NextAction[] {
  switch (job.status) {
    case "queued":
    case "running":
      return [
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

export function toJobView(job: Job, stages: Stage[], approval?: Approval, spend?: JobSpendDetail): JobView {
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
    })),
    approval: approval ? toApprovalView(approval) : undefined,
    agent: jobAgent(job),
    next: nextActionsForJob(job, approval),
  };
}
