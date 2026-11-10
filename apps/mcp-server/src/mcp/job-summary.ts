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
  const failedStage =
    job.status === "failed" ? job.stages.find((s) => s.status === "failed")?.name : undefined;
  const warnings = job.stages.flatMap((s) => (s.warning ? [{ stage: s.name, warning: s.warning }] : []));
  const fallbacks = job.stages.flatMap((s) => (s.fallback ? [{ stage: s.name, fallback: s.fallback }] : []));
  return {
    view: "summary" as const,
    revision: jobRevision(job),
    id: job.id,
    kind: job.kind,
    status: job.status,
    ...(job.projectId ? { projectId: job.projectId } : {}),
    ...(job.stage ? { stage: job.stage } : {}),
    progress: job.progress,
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
