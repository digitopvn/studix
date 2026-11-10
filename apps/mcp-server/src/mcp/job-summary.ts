import type { NextAction } from "@studix/core";
import type { JobWithVideo } from "../resource-views.ts";

export const JOB_VIEWS = ["summary", "detail"] as const;
export type JobViewName = (typeof JOB_VIEWS)[number];

/** Changes whenever the job changes; a caller passes it back as `sinceRevision` to skip an unchanged poll. */
export function jobRevision(job: Pick<JobWithVideo, "updatedAt" | "status">): string {
  return `${new Date(job.updatedAt).toISOString()}:${job.status}`;
}

/**
 * What a host needs to decide its next step, without the stage list: status, stage, progress, what blocks
 * the job, the result or error, the video, the spend and the next action. `studix_get_job` with
 * `view: "detail"` (the default) returns the full job.
 */
export function summarizeJob(job: JobWithVideo, next: NextAction[], reviewUrl: string | undefined) {
  const blocker = jobBlocker(job);
  // Stage rows of every attempt are listed, oldest first: look at the newest row of each stage only.
  const latest = [...new Map(job.stages.map((s) => [s.name, s])).values()];
  const failedStage =
    job.status === "failed"
      ? typeof job.error?.details?.stage === "string"
        ? job.error.details.stage
        : (latest.findLast((s) => s.status === "failed")?.name ?? job.stage)
      : undefined;
  const warnings = latest.flatMap((s) => (s.warning ? [{ stage: s.name, warning: s.warning }] : []));
  const fallbacks = latest.flatMap((s) => (s.fallback ? [{ stage: s.name, fallback: s.fallback }] : []));
  return {
    view: "summary" as const,
    revision: jobRevision(job),
    id: job.id,
    kind: job.kind,
    status: job.status,
    ...(job.projectId ? { projectId: job.projectId } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    ...(job.cancelRequested ? { cancelRequested: true } : {}),
    ...(blocker ? { blocker } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error
      ? {
          error: {
            code: job.error.code,
            message: job.error.message,
            ...(job.error.retryable !== undefined ? { retryable: job.error.retryable } : {}),
            ...(job.error.suggestedAction ? { suggestedAction: job.error.suggestedAction } : {}),
            ...(failedStage ? { stage: failedStage } : {}),
          },
        }
      : {}),
    ...(job.video ? { video: job.video } : {}),
    ...(job.videoUnavailableReason ? { videoUnavailableReason: job.videoUnavailableReason } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(fallbacks.length ? { fallbacks } : {}),
    agent: job.agent,
    cost: {
      spentCents: job.budget.spentCents,
      ...(job.budget.limitCents !== undefined ? { limitCents: job.budget.limitCents } : {}),
    },
    ...(reviewUrl ? { reviewUrl } : {}),
    nextAction: next[0],
  };
}

function jobBlocker(job: JobWithVideo): { type: string; reason: string } | undefined {
  switch (job.status) {
    case "waiting_approval":
      return {
        type: "approval",
        reason: job.approval?.reason ?? "Waiting for a workspace member to approve.",
      };
    case "waiting_host":
      return { type: "host_task", reason: `Stage ${job.stage ?? "?"} waits for the host agent.` };
    case "queued":
      return job.queue ? { type: "queue", reason: job.queue.reason } : undefined;
    default:
      return undefined;
  }
}
