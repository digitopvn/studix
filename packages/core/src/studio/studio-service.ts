import { StudixError } from "@studix/shared";
import type { Asset, AssetKind } from "../entities/asset.ts";
import type { Render } from "../entities/job.ts";
import type { ProjectVersion, VideoProject } from "../entities/project.ts";
import type { Approval } from "../entities/review.ts";
import type { AuditEvent } from "../entities/telemetry.ts";
import type { Page, PageRequest } from "../repositories/pagination.ts";
import { actorRef, assertPermission, type TenantContext } from "../tenant.ts";
import {
  assertSubjectExists,
  decideApproval,
  ensureActionApproved,
  openApproval,
} from "./approval-operations.ts";
import { type CreateVideoProjectResult, createVideoProject } from "./create-video-project.ts";
import {
  decideStoryboard,
  type FeedbackResult,
  getProjectReview,
  type ProjectReview,
  type RenderResult,
  renderVersion,
  type StoryboardDecisionResult,
  submitFeedback,
} from "./project-review.ts";
import { loadJobView, parseInput, type ResolvedStudioDeps } from "./studio-input.ts";
import {
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
  getProjectReview(ctx: TenantContext, projectId: string): Promise<ProjectReview> {
    return getProjectReview(this.deps, ctx, projectId);
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
