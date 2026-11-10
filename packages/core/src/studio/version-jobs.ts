import { StudixError } from "@studix/shared";
import type { RenderPreset } from "@studix/video-ir";
import { JOB_KINDS, type Job } from "../entities/job.ts";
import type { ProjectVersion, VideoProject } from "../entities/project.ts";
import type { Approval } from "../entities/review.ts";
import { decideFailClosed } from "../ports/approval-policy.ts";
import { actorRef, type TenantContext } from "../tenant.ts";
import { openApproval } from "./approval-operations.ts";
import { toJobView } from "./job-view.ts";
import { loadJobView, type ResolvedStudioDeps } from "./studio-input.ts";
import { DEFAULT_WORKFLOW_TEMPLATE, type JobView } from "./studio-types.ts";

export interface VersionJobRequest {
  project: VideoProject;
  version: ProjectVersion;
  renderPreset?: RenderPreset;
  idempotencyKey?: string;
  budgetCents?: number;
  /**
   * Whether rendering moves the project's head to this version (default true). Turn it off when the head was
   * already settled at queue time, so a job that runs later cannot revert a newer version.
   */
  makeCurrent?: boolean;
  /** Extra payload fields recorded with the job (e.g. the feedback that produced the version). */
  extra?: Record<string, unknown>;
}

export interface VersionJobResult {
  job: JobView;
  approval?: Approval;
  replayed: boolean;
}

/** An earlier job with the same idempotency key, as a replay result; undefined when there is none. */
export async function replayVersionJob(
  deps: ResolvedStudioDeps,
  ctx: TenantContext,
  idempotencyKey: string | undefined,
): Promise<(VersionJobResult & { raw: Job }) | undefined> {
  if (!idempotencyKey) return undefined;
  const existing = await deps.jobs.findByIdempotencyKey(ctx, idempotencyKey);
  if (!existing) return undefined;
  return { job: await loadJobView(deps, ctx, existing), replayed: true, raw: existing };
}

/**
 * Queue a `video.create` job for a stored version: the worker skips planning, renders the version and, unless
 * `makeCurrent` is false, makes it current. Gated by the approval policy like any job start (above the threshold it waits for a human).
 */
export async function enqueueVersionJob(
  deps: ResolvedStudioDeps,
  ctx: TenantContext,
  request: VersionJobRequest,
): Promise<VersionJobResult> {
  const { project, version } = request;
  if (version.projectId !== project.id)
    throw new StudixError("NOT_FOUND", `project version ${version.id} not found`);
  const now = deps.clock.now();
  const budgetCents = request.budgetCents ?? deps.defaults.jobBudgetCents;
  const createdBy = actorRef(ctx.actor);
  const requirement = await decideFailClosed(deps.approvalPolicy, ctx, {
    action: "job.start",
    subject: { type: "project", id: project.id },
    estimatedCostCents: budgetCents,
  });
  const enqueued = await deps.queue.enqueue(ctx, {
    kind: JOB_KINDS.createVideo,
    projectId: project.id,
    payload: {
      ...request.extra,
      projectId: project.id,
      versionId: version.id,
      renderPreset: request.renderPreset ?? "preview",
      makeCurrent: request.makeCurrent ?? true,
      workflowTemplate: project.workflowTemplate ?? DEFAULT_WORKFLOW_TEMPLATE,
    },
    idempotencyKey: request.idempotencyKey,
    budgetCents,
    deadlineAt: new Date(now.getTime() + deps.defaults.jobDeadlineMs),
    deadlineFromClaim: true,
    maxAttempts: deps.defaults.jobMaxAttempts,
    initialStatus: requirement.required ? "waiting_approval" : "queued",
    createdBy,
  });
  if (!enqueued.created) {
    return { job: await loadJobView(deps, ctx, enqueued.job), replayed: true };
  }
  const job = enqueued.job;
  const approval = requirement.required
    ? await openApproval(deps, ctx, {
        action: "job.start",
        subject: { type: "job", id: job.id },
        reason: requirement.reason,
        estimatedCostCents: budgetCents,
      })
    : undefined;
  await deps.audit.append(ctx, {
    actor: createdBy,
    action: "project.render_requested",
    subjectType: "project",
    subjectId: project.id,
    data: { jobId: job.id, versionId: version.id, approvalId: approval?.id, budgetCents },
  });
  return { job: toJobView(job, [], approval), approval, replayed: false };
}
