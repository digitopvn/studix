import type { JobWithVideo } from "../resource-views.ts";

export const JOB_VIEWS = ["summary", "detail"] as const;
export type JobViewName = (typeof JOB_VIEWS)[number];

/**
 * Compact job shape for polling hosts: what is needed to decide the next step (status, stage, progress,
 * what blocks the job, the result and cost) without the per-stage history. `detail` stays the full view.
 */
export function summarizeJob(job: JobWithVideo & { reviewUrl?: string }) {
  const blocker = job.error
    ? {
        kind: "error" as const,
        code: job.error.code,
        retryable: job.error.retryable,
        message: job.error.message,
        suggestedAction: job.error.suggestedAction,
      }
    : job.approval && job.approval.status === "pending"
      ? { kind: "approval" as const, message: job.approval.reason }
      : job.queue
        ? { kind: "queue" as const, message: job.queue.reason }
        : undefined;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    ...(blocker ? { blocker } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.video ? { video: job.video } : {}),
    ...(job.videoUnavailableReason ? { videoUnavailableReason: job.videoUnavailableReason } : {}),
    budget: job.budget,
    agent: job.agent,
    updatedAt: job.updatedAt,
    ...(job.projectId ? { projectId: job.projectId } : {}),
    ...(job.reviewUrl ? { reviewUrl: job.reviewUrl } : {}),
  };
}
