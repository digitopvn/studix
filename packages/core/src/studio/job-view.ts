import type { Job, Stage } from "../entities/job.ts";
import type { Approval } from "../entities/review.ts";
import { AGENT_HANDOFF_TOOLS } from "./agent-handoff-service.ts";
import { type ApprovalView, type JobView, type NextAction, STUDIX_TOOLS } from "./studio-types.ts";

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
      if (job.projectId) {
        hints.push({
          tool: STUDIX_TOOLS.getProject,
          arguments: { projectId: job.projectId },
          reason: job.error?.suggestedAction ?? "Inspect the project and its last version before retrying.",
        });
      }
      // Retrying cannot help a rejected gate or an exhausted budget (spend is kept across a retry).
      if (!["FORBIDDEN", "BUDGET_EXCEEDED", "APPROVAL_REQUIRED"].includes(job.error?.code ?? "")) {
        hints.push({
          tool: STUDIX_TOOLS.retryJob,
          arguments: { jobId: job.id },
          reason:
            "After fixing the cause, requeue this job: finished stages and media already paid for are reused.",
        });
      }
      return hints;
    }
    case "cancelled":
      return [];
  }
}

export function toJobView(job: Job, stages: Stage[], approval?: Approval): JobView {
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
    })),
    approval: approval ? toApprovalView(approval) : undefined,
    next: nextActionsForJob(job, approval),
  };
}
