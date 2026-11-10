import { StudixError } from "@studix/shared";
import { unwrapValidation, type ValidationResult, type VideoIR, validateVideoIR } from "@studix/video-ir";
import { JOB_KINDS, type Job } from "../entities/job.ts";
import type { ProjectVersion, VideoProject } from "../entities/project.ts";
import type { Approval } from "../entities/review.ts";
import { decideFailClosed } from "../ports/approval-policy.ts";
import { actorRef, assertPermission, type TenantContext } from "../tenant.ts";
import { openApproval } from "./approval-operations.ts";
import { toJobView } from "./job-view.ts";
import { loadJobView, parseInput, type ResolvedStudioDeps, titleFromPrompt } from "./studio-input.ts";
import {
  CreateVideoProjectInput,
  DEFAULT_WORKFLOW_TEMPLATE,
  type JobView,
  type NextAction,
} from "./studio-types.ts";

/** Default window for a skill-agent job, counted from its first claim. */
export const SKILL_AGENT_DEADLINE_MS = 60 * 60_000;

export interface CreateVideoProjectResult {
  project: VideoProject;
  job: JobView;
  /** Present when the job waits for a human approval before starting. */
  approval?: Approval;
  /** True when an earlier call with the same idempotency key was returned. */
  replayed: boolean;
  next: NextAction[];
}

async function replay(
  deps: ResolvedStudioDeps,
  ctx: TenantContext,
  job: Job,
): Promise<CreateVideoProjectResult> {
  const project = job.projectId ? await deps.projects.get(ctx, job.projectId) : undefined;
  if (!project) throw new StudixError("CONFLICT", "idempotency key belongs to a job without a project");
  const view = await loadJobView(deps, ctx, job);
  return { project, job: view, replayed: true, next: view.next };
}

/**
 * One goal -> project (+ optional client spec as version 1) -> durable job. Returns immediately; the
 * worker does the planning/rendering. High-cost jobs start parked in waiting_approval.
 */
export async function createVideoProject(
  deps: ResolvedStudioDeps,
  ctx: TenantContext,
  rawInput: CreateVideoProjectInput,
): Promise<CreateVideoProjectResult> {
  assertPermission(ctx, "project:write");
  const parsed = parseInput(CreateVideoProjectInput, rawInput, "createVideoProject input");
  if (parsed.planner && parsed.agent) {
    throw new StudixError("VALIDATION", "planner is an alias of agent: pass one of them, not both");
  }
  // A Claude agent runs the Claude planner path, so it keeps the legacy planner field the worker reads.
  const input =
    parsed.agent?.runtime === "claude"
      ? {
          ...parsed,
          planner: { runtime: "claude" as const, providerConnectionId: parsed.agent.connectionId },
        }
      : parsed;
  if (input.planner && input.spec !== undefined) {
    // A client spec skips planning, so a planner choice would be silently ignored.
    throw new StudixError(
      "VALIDATION",
      "planner cannot be combined with spec: a supplied spec is not planned",
    );
  }
  // A planner with a pack is valid: the pack's pipeline runs and its agent stages run on the planner's
  // Claude connection (the worker's agent harness), while the default pack plans with the Claude planner.
  const spec: VideoIR | undefined =
    input.spec === undefined
      ? undefined
      : unwrapValidation(validateVideoIR(input.spec) as ValidationResult<VideoIR>, "spec (VideoIR)");
  const { projects, jobs, queue, clock, defaults } = deps;
  const now = clock.now();
  const workflowTemplate = input.workflowTemplate ?? DEFAULT_WORKFLOW_TEMPLATE;
  // An agent authoring the whole video needs longer than a pack run, and its default window starts at
  // the first claim so time spent queued behind other jobs does not eat it.
  const agentAuthored = workflowTemplate === "skill-agent" && input.deadlineAt === undefined;
  const roles = input.roles && Object.keys(input.roles).length > 0 ? input.roles : undefined;
  if (roles && workflowTemplate !== "skill-agent") {
    throw new StudixError("VALIDATION", "roles need workflowTemplate skill-agent", {
      retryable: false,
      suggestedAction: "Set workflowTemplate to skill-agent, or drop roles.",
    });
  }
  const deadlineAt =
    input.deadlineAt ??
    new Date(now.getTime() + (agentAuthored ? SKILL_AGENT_DEADLINE_MS : defaults.jobDeadlineMs));
  if (deadlineAt <= now) throw new StudixError("VALIDATION", "deadlineAt must be in the future");
  const budgetCents = input.budgetCents ?? defaults.jobBudgetCents;

  if (input.idempotencyKey) {
    const existing = await jobs.findByIdempotencyKey(ctx, input.idempotencyKey);
    if (existing) return replay(deps, ctx, existing);
  }

  const createdBy = actorRef(ctx.actor);
  const project = await projects.create(ctx, {
    title: input.title ?? input.brief.title ?? spec?.title ?? titleFromPrompt(input.brief.prompt),
    status: "draft",
    brief: input.brief,
    workflowTemplate,
    createdBy,
  });
  let version: ProjectVersion | undefined;
  if (spec) {
    version = await projects.createVersion(ctx, {
      projectId: project.id,
      ir: spec,
      source: "client",
      createdBy,
    });
    await projects.update(ctx, project.id, { currentVersionId: version.id });
  }

  const requirement = await decideFailClosed(deps.approvalPolicy, ctx, {
    action: "job.start",
    subject: { type: "project", id: project.id },
    estimatedCostCents: budgetCents,
  });
  const enqueued = await queue.enqueue(ctx, {
    kind: JOB_KINDS.createVideo,
    projectId: project.id,
    payload: {
      projectId: project.id,
      versionId: version?.id,
      renderPreset: input.renderPreset ?? "preview",
      planner: input.planner,
      workflowTemplate,
      ...(input.agentMode ? { agentMode: input.agentMode } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(roles ? { roles } : {}),
    },
    idempotencyKey: input.idempotencyKey,
    budgetCents,
    deadlineAt,
    // A default window starts at the first claim, so time queued behind other jobs never eats it; a
    // deadline the caller chose stays the absolute time they asked for.
    ...(input.deadlineAt === undefined ? { deadlineFromClaim: true } : {}),
    maxAttempts: defaults.jobMaxAttempts,
    initialStatus: requirement.required ? "waiting_approval" : "queued",
    createdBy,
  });
  if (!enqueued.created) {
    // Lost an idempotency race: drop the orphan project and return the winner's.
    await projects.delete(ctx, project.id);
    return replay(deps, ctx, enqueued.job);
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
    action: "project.created",
    subjectType: "project",
    subjectId: project.id,
    data: { jobId: job.id, versionId: version?.id, approvalId: approval?.id, budgetCents },
  });
  deps.logger?.info("project created", { projectId: project.id, jobId: job.id, status: job.status });
  const current = (await projects.get(ctx, project.id)) ?? project;
  const view = toJobView(job, [], approval);
  return { project: current, job: view, approval, replayed: false, next: view.next };
}
