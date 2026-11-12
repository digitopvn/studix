import { StudixError } from "@studix/shared";
import type { Asset, AssetKind } from "../entities/asset.ts";
import { JOB_KINDS, type Render } from "../entities/job.ts";
import type { ProjectVersion, VideoProject } from "../entities/project.ts";
import type { Approval } from "../entities/review.ts";
import type { AuditEvent } from "../entities/telemetry.ts";
import type { MediaJobRecord } from "../ports/media-provider.ts";
import type { Page, PageRequest } from "../repositories/pagination.ts";
import { actorRef, assertPermission, type TenantContext } from "../tenant.ts";
import {
  assertSubjectExists,
  decideApproval,
  ensureActionApproved,
  openApproval,
} from "./approval-operations.ts";
import { verifyAttachableProviderJob } from "./attach-media-job-verification.ts";
import { type CreateVideoProjectResult, createVideoProject } from "./create-video-project.ts";
import { type JobTraceInput, type JobTraceView, readJobTrace } from "./job-trace.ts";
import {
  decideStoryboard,
  type FeedbackResult,
  getFeedbackImage,
  getProjectReview,
  type ProjectReview,
  type RenderResult,
  renderVersion,
  type StoryboardDecisionResult,
  submitFeedback,
} from "./project-review.ts";
import { loadJobView, parseInput, type ResolvedStudioDeps } from "./studio-input.ts";
import {
  AttachMediaJobRequest,
  type CreateVideoProjectInput,
  DecideApprovalInput,
  type FeedbackInput,
  type JobView,
  RecordAuditInput,
  type RenderVersionInput,
  RequestApprovalInput,
  type StoryboardDecisionInput,
  type StudioDefaults,
  type StudioServiceDeps,
} from "./studio-types.ts";

export type { CreateVideoProjectResult };

export const DEFAULT_STUDIO_DEFAULTS: StudioDefaults = {
  jobBudgetCents: 500,
  jobDeadlineMs: 30 * 60_000,
  jobMaxAttempts: 3,
  approvalTtlMs: 7 * 24 * 60 * 60_000,
};

export interface ProjectDetails {
  project: VideoProject;
  currentVersion?: ProjectVersion;
  jobs: JobView[];
  renders: Render[];
}

export interface EnsureApprovedInput {
  action: RequestApprovalInput["action"];
  subjectType: RequestApprovalInput["subjectType"];
  subjectId: string;
  estimatedCostCents?: number;
}

/**
 * Application service shared by the MCP server and the dashboard API. Depends only on repository and
 * port interfaces; every call is tenant-scoped and permission-checked. Cross-tenant ids surface as
 * NOT_FOUND so existence never leaks.
 */
export class StudioService {
  private readonly deps: ResolvedStudioDeps;

  constructor(deps: StudioServiceDeps) {
    this.deps = { ...deps, defaults: { ...DEFAULT_STUDIO_DEFAULTS, ...deps.defaults } };
  }

  createVideoProject(ctx: TenantContext, input: CreateVideoProjectInput): Promise<CreateVideoProjectResult> {
    return createVideoProject(this.deps, ctx, input);
  }

  async getJob(ctx: TenantContext, jobId: string): Promise<JobView> {
    assertPermission(ctx, "project:read");
    const job = await this.deps.jobs.get(ctx, jobId);
    if (!job) throw new StudixError("NOT_FOUND", `job ${jobId} not found`);
    return loadJobView(this.deps, ctx, job);
  }

  /** What each agent stage run of a job did, from its session traces (`studix_job_trace`). */
  getJobTrace(ctx: TenantContext, input: JobTraceInput): Promise<JobTraceView> {
    return readJobTrace(this.deps, ctx, input);
  }

  async cancelJob(ctx: TenantContext, jobId: string, reason?: string): Promise<JobView> {
    assertPermission(ctx, "job:cancel");
    const job = await this.deps.jobs.get(ctx, jobId);
    if (!job) throw new StudixError("NOT_FOUND", `job ${jobId} not found`);
    const cancelled = await this.deps.queue.cancel(ctx, jobId, reason);
    await this.recordAudit(ctx, {
      action: "job.cancel_requested",
      subjectType: "job",
      subjectId: jobId,
      data: { reason },
    });
    return loadJobView(this.deps, ctx, cancelled);
  }

  /**
   * Requeue a failed job as the same job, after its cause was fixed. Succeeded stages keep their outputs and
   * the stage's media job journal is reused, so upstream calls that already completed are collected rather
   * than paid again; gates already decided are not asked again. Publish jobs are not resumable: a publish
   * is not idempotent and must be started again on purpose.
   */
  async retryJob(ctx: TenantContext, jobId: string): Promise<JobView> {
    assertPermission(ctx, "job:retry");
    const job = await this.deps.jobs.get(ctx, jobId);
    if (!job) throw new StudixError("NOT_FOUND", `job ${jobId} not found`);
    if (job.kind === JOB_KINDS.publish) {
      throw new StudixError("VALIDATION", "publish jobs cannot be retried", {
        retryable: false,
        suggestedAction: "Start a new publish once the cause is fixed.",
      });
    }
    // The worker never checks `job.start`; an expired or rejected request fails the job, and a retry must not
    // start it without the person who gates it.
    const start = await this.deps.approvals.findLatest(ctx, { type: "job", id: jobId }, "job.start");
    if (start && !(start.status === "approved" && start.decidedBy?.type === "user")) {
      throw new StudixError("APPROVAL_REQUIRED", `job ${jobId} was never approved to start`, {
        retryable: false,
        details: { approvalId: start.id, approvalStatus: start.status },
        suggestedAction: "Create the job again and have a workspace member approve it in the dashboard.",
      });
    }
    const requeued = await this.deps.queue.retry(ctx, jobId);
    await this.recordAudit(ctx, {
      action: "job.retried",
      subjectType: "job",
      subjectId: jobId,
      data: { attempts: job.attempts, error: job.error?.code },
    });
    return loadJobView(this.deps, ctx, requeued);
  }

  /**
   * Operator recovery of an Atlas call stuck at "submitting" (Atlas accepted or may have accepted the run,
   * but its prediction id never reached the journal): record the prediction found in `multix history` or
   * the Atlas Cloud console, so {@link retryJob} collects that paid job instead of being blocked. Needs
   * `job:recover` (platform operators only: the prediction is fetched with the platform's provider key and
   * billed to this job), the prediction must match the record (see {@link verifyAttachableProviderJob}),
   * and the job must be failed so no worker holds it.
   */
  async attachMediaJob(
    ctx: TenantContext,
    rawInput: AttachMediaJobRequest,
  ): Promise<{ job: JobView; mediaJob: MediaJobRecord }> {
    assertPermission(ctx, "job:recover");
    const input = parseInput(AttachMediaJobRequest, rawInput, "media job attachment");
    const job = await this.deps.jobs.get(ctx, input.jobId);
    if (!job) throw new StudixError("NOT_FOUND", `job ${input.jobId} not found`);
    await verifyAttachableProviderJob(this.deps, ctx, input);
    const mediaJob = await this.deps.queue.attachMediaJob(ctx, {
      jobId: job.id,
      stage: input.stage,
      idempotencyKey: input.idempotencyKey,
      job: { provider: "atlas", id: input.predictionId },
    });
    await this.recordAudit(ctx, {
      action: "job.media_job_attached",
      subjectType: "job",
      subjectId: job.id,
      data: {
        stage: input.stage,
        idempotencyKey: input.idempotencyKey,
        provider: "atlas",
        predictionId: input.predictionId,
        attempt: mediaJob.attempt,
      },
    });
    // The job itself is unchanged and still failed: its view offers the retry that collects the job.
    return { job: await loadJobView(this.deps, ctx, job), mediaJob };
  }

  async getProject(ctx: TenantContext, projectId: string): Promise<ProjectDetails> {
    assertPermission(ctx, "project:read");
    const project = await this.deps.projects.get(ctx, projectId);
    if (!project) throw new StudixError("NOT_FOUND", `project ${projectId} not found`);
    const [currentVersion, jobs, renders] = await Promise.all([
      project.currentVersionId ? this.deps.projects.getVersion(ctx, project.currentVersionId) : undefined,
      this.deps.jobs.list(ctx, { projectId, limit: 10 }),
      this.deps.renders.listByProject(ctx, projectId, { limit: 20 }),
    ]);
    const jobViews = await Promise.all(jobs.items.map((job) => loadJobView(this.deps, ctx, job)));
    return { project, currentVersion, jobs: jobViews, renders: renders.items };
  }

  async listProjects(ctx: TenantContext, query: PageRequest = {}): Promise<Page<VideoProject>> {
    assertPermission(ctx, "project:read");
    return this.deps.projects.list(ctx, query);
  }

  async listAssets(
    ctx: TenantContext,
    query: PageRequest & { projectId?: string; kind?: AssetKind } = {},
  ): Promise<Page<Asset>> {
    assertPermission(ctx, "asset:read");
    return this.deps.assets.list(ctx, query);
  }

  async requestApproval(ctx: TenantContext, rawInput: RequestApprovalInput): Promise<Approval> {
    assertPermission(ctx, "approval:request");
    const input = parseInput(RequestApprovalInput, rawInput, "approval request");
    const subject = { type: input.subjectType, id: input.subjectId };
    await assertSubjectExists(this.deps, ctx, subject);
    return openApproval(this.deps, ctx, {
      action: input.action,
      subject,
      reason: input.reason ?? `${input.action} requested`,
      estimatedCostCents: input.estimatedCostCents,
    });
  }

  /** Approve or reject. Every decision needs a signed-in user; API keys and system actors get FORBIDDEN. */
  approve(ctx: TenantContext, input: DecideApprovalInput): Promise<Approval> {
    return decideApproval(this.deps, ctx, parseInput(DecideApprovalInput, input, "approval decision"));
  }

  /** Gate for side-effecting actions (publish, final render, spend). Throws APPROVAL_REQUIRED when blocked. */
  ensureApproved(
    ctx: TenantContext,
    input: EnsureApprovedInput,
  ): Promise<{ required: boolean; approval?: Approval }> {
    return ensureActionApproved(this.deps, ctx, {
      action: input.action,
      subject: { type: input.subjectType, id: input.subjectId },
      estimatedCostCents: input.estimatedCostCents,
    });
  }

  /** Script, storyboard with review state, shots, timeline, versions, renders, cost and comments. */
  getFeedbackImage(ctx: TenantContext, projectId: string, feedbackId: string, n: number) {
    return getFeedbackImage(this.deps, ctx, projectId, feedbackId, n);
  }

  getProjectReview(
    ctx: TenantContext,
    projectId: string,
    opts?: { images?: boolean },
  ): Promise<ProjectReview> {
    return getProjectReview(this.deps, ctx, projectId, opts);
  }

  /** Approve or request changes on the storyboard, a scene or a shot (signed-in reviewers only). */
  decideStoryboard(ctx: TenantContext, input: StoryboardDecisionInput): Promise<StoryboardDecisionResult> {
    return decideStoryboard(this.deps, ctx, input);
  }

  /** Comment on a shot, scene, asset or time range; with a patch, store a new version and queue a render. */
  submitFeedback(ctx: TenantContext, input: FeedbackInput): Promise<FeedbackResult> {
    return submitFeedback(this.deps, ctx, input);
  }

  /** Queue a render of a stored version (the current one by default). */
  renderVersion(ctx: TenantContext, input: RenderVersionInput): Promise<RenderResult> {
    return renderVersion(this.deps, ctx, input);
  }

  async recordAudit(ctx: TenantContext, rawInput: RecordAuditInput): Promise<AuditEvent> {
    const input = parseInput(RecordAuditInput, rawInput, "audit event");
    return this.deps.audit.append(ctx, { actor: actorRef(ctx.actor), ...input });
  }
}
