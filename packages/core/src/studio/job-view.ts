import type { Job, Stage } from "../entities/job.ts";
import type { Approval } from "../entities/review.ts";
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
              tool: STUDIX_TOOLS.approve,
              arguments: { approvalId: approval.id, decision: "approved" },
              reason: `A workspace reviewer must approve: ${approval.reason}`,
            },
          ]
        : [];
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
