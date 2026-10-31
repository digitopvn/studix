import { StudixError } from "@studix/shared";
import {
  applyPatch,
  dependentsOf,
  nodeDigests,
  nodeKey,
  type Storyboard,
  type StoryboardApproval,
  type StoryboardReviewStatus,
  type VideoIR,
  type VideoIRPatch,
  videoIrNodes,
} from "@studix/video-ir";
import type { Render } from "../entities/job.ts";
import type { ProjectVersion, ProjectVersionSource, VideoProject } from "../entities/project.ts";
import type { Approval, Review } from "../entities/review.ts";
import type { ProjectStoryboard } from "../entities/storyboard.ts";
import type { ProjectRepository } from "../repositories/project-repository.ts";
import type { StoryboardRepository } from "../repositories/storyboard-repository.ts";
import { actorRef, assertPermission, can, type TenantContext } from "../tenant.ts";
import {
  type ShotPlacement,
  type StoryboardTarget,
  setStoryboardApproval,
  shotPlacements,
  shotScript,
  shotsWithChangesRequested,
  storyboardFromVideoIR,
  storyboardTargetKey,
  syncStoryboard,
} from "./storyboard-review.ts";
import { parseInput, type ResolvedStudioDeps } from "./studio-input.ts";
import {
  FeedbackInput,
  type JobView,
  type NextAction,
  RenderVersionInput,
  STUDIX_TOOLS,
  StoryboardDecisionInput,
} from "./studio-types.ts";
import { enqueueVersionJob, replayVersionJob } from "./version-jobs.ts";

type Deps = ResolvedStudioDeps;

/** The storyboard that describes a project version, with the stored revision it is based on. */
export interface EffectiveStoryboard {
  storyboard: Storyboard;
  /** Latest stored revision (0 before the first review decision). */
  revision: number;
  /** False when the storyboard was derived for this version and not stored yet. */
  stored: boolean;
}

/**
 * Storyboard of `version`: the stored one when it describes this version, else derived from the IR with
 * the review state of the latest stored revision carried over for every unchanged scene and shot.
 */
export async function effectiveStoryboard(
  deps: {
    projects: Pick<ProjectRepository, "getVersion">;
    storyboards: Pick<StoryboardRepository, "latest">;
  },
  ctx: TenantContext,
  version: ProjectVersion,
): Promise<EffectiveStoryboard> {
  const latest = await deps.storyboards.latest(ctx, version.projectId);
  if (!latest) return { storyboard: storyboardFromVideoIR(version.ir), revision: 0, stored: false };
  if (latest.versionId === version.id)
    return { storyboard: latest.storyboard, revision: latest.revision, stored: true };
  const described = await deps.projects.getVersion(ctx, latest.versionId);
  const storyboard = described
    ? syncStoryboard(latest.storyboard, described.ir, version.ir)
    : storyboardFromVideoIR(version.ir);
  return { storyboard, revision: latest.revision, stored: false };
}

/**
 * Review status of the storyboard of the project's current version, or undefined when nothing has been
 * planned yet. Engine stages that need a human-approved plan (image-to-video) check this before running.
 */
export async function storyboardStatus(
  deps: {
    projects: Pick<ProjectRepository, "get" | "getVersion">;
    storyboards: Pick<StoryboardRepository, "latest">;
  },
  ctx: TenantContext,
  projectId: string,
): Promise<StoryboardReviewStatus | undefined> {
  const project = await deps.projects.get(ctx, projectId);
  if (!project?.currentVersionId) return undefined;
  const version = await deps.projects.getVersion(ctx, project.currentVersionId);
  if (!version) return undefined;
  return (await effectiveStoryboard(deps, ctx, version)).storyboard.approval.status;
}

async function requireProject(deps: Deps, ctx: TenantContext, projectId: string): Promise<VideoProject> {
  const project = await deps.projects.get(ctx, projectId);
  if (!project) throw new StudixError("NOT_FOUND", `project ${projectId} not found`);
  return project;
}

async function requireCurrentVersion(
  deps: Deps,
  ctx: TenantContext,
  project: VideoProject,
): Promise<ProjectVersion> {
  const version = project.currentVersionId
    ? await deps.projects.getVersion(ctx, project.currentVersionId)
    : undefined;
  if (!version) {
    throw new StudixError("CONFLICT", `project ${project.id} has no version yet`, {
      suggestedAction: "Wait for the create job to plan the video (poll studix_get_job), then retry.",
    });
  }
  return version;
}

/** Commenting is open to editors and reviewers; viewers and read-only keys only read. */
function assertCanComment(ctx: TenantContext): void {
  if (can(ctx.actor, "project:write") || can(ctx.actor, "approval:decide")) return;
  assertPermission(ctx, "project:write");
}

// ---------------------------------------------------------------------------------------------------------
// Review view

export type ShotRenderState = "rendered" | "outdated" | "not_rendered";

export interface ReviewShot {
  id: string;
  kind: string;
  description: string;
  script?: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** JSON pointer of the shot in the current IR (for feedback patches). */
  pointer: string;
  approval: StoryboardApproval;
  /**
   * Render state of this shot's current content: `rendered` when a finished render contains it unchanged,
   * `outdated` when only an earlier revision was rendered, `not_rendered` otherwise. Independent of approval.
   */
  render: ShotRenderState;
  /** Scene/shot revision number, once the version was recorded. */
  revision?: number;
  /** Changed in the current version compared to its parent version. */
  changed: boolean;
  comments: number;
}

export interface ReviewScene {
  id: string;
  title: string;
  summary?: string;
  startMs: number;
  endMs: number;
  approval: StoryboardApproval;
  revision?: number;
  changed: boolean;
  shots: ReviewShot[];
}

export interface ReviewVersion {
  id: string;
  version: number;
  source: ProjectVersionSource;
  parentVersionId?: string;
  description?: string;
  createdAt: Date;
}

export interface ProjectReview {
  project: VideoProject;
  workflowTemplate?: string;
  currentVersion?: ReviewVersion;
  versions: ReviewVersion[];
  /** The brief prompt and the words each shot puts on screen, in timeline order. */
  script: {
    prompt: string;
    lines: Array<{ sceneId: string; shotId: string; startMs: number; endMs: number; text: string }>;
  };
  timeline?: { durationMs: number; fps: number; aspectRatio: string; width: number; height: number };
  storyboard?: {
    revision: number;
    stored: boolean;
    title: string;
    approval: StoryboardApproval;
    scenes: ReviewScene[];
    /** Shots not yet approved. */
    pendingShots: number;
  };
  renders: Array<Render & { version?: number }>;
  cost: {
    spentCents: number;
    jobs: Array<
      Pick<JobView, "id" | "kind" | "status" | "createdAt"> & { spentCents: number; budgetCents?: number }
    >;
  };
  comments: Review[];
  /** Node keys changed by the current version compared to its parent. */
  invalidated: string[];
}

function versionView(version: ProjectVersion): ReviewVersion {
  return {
    id: version.id,
    version: version.version,
    source: version.source,
    parentVersionId: version.parentVersionId,
    description: version.patch?.description,
    createdAt: version.createdAt,
  };
}

function digestsOf(ir: VideoIR): Map<string, string> {
  return nodeDigests(videoIrNodes(ir));
}

/** Everything the review page shows for one project, read in the caller's tenant. */
export async function getProjectReview(
  deps: Deps,
  ctx: TenantContext,
  projectId: string,
): Promise<ProjectReview> {
  assertPermission(ctx, "project:read");
  const project = await requireProject(deps, ctx, projectId);
  const [versions, jobs, renders, comments] = await Promise.all([
    deps.projects.listVersions(ctx, projectId, { limit: 50 }),
    deps.jobs.list(ctx, { projectId, limit: 50 }),
    deps.renders.listByProject(ctx, projectId, { limit: 50 }),
    deps.reviews.list(ctx, { projectId, limit: 100 }),
  ]);
  const current = project.currentVersionId
    ? (versions.items.find((v) => v.id === project.currentVersionId) ??
      (await deps.projects.getVersion(ctx, project.currentVersionId)))
    : undefined;
  const versionNumbers = new Map(versions.items.map((v) => [v.id, v.version]));
  const base: ProjectReview = {
    project,
    workflowTemplate: project.workflowTemplate,
    currentVersion: current ? versionView(current) : undefined,
    versions: versions.items.map(versionView),
    script: { prompt: project.brief.prompt, lines: [] },
    renders: renders.items.map((r) => ({ ...r, version: versionNumbers.get(r.versionId) })),
    cost: {
      spentCents: jobs.items.reduce((sum, j) => sum + j.spentCents, 0),
      jobs: jobs.items.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        createdAt: j.createdAt,
        spentCents: j.spentCents,
        budgetCents: j.budgetCents,
      })),
    },
    comments: comments.items,
    invalidated: [],
  };
  if (!current) return base;

  const ir = current.ir;
  const digests = digestsOf(ir);
  const parent = current.parentVersionId
    ? (versions.items.find((v) => v.id === current.parentVersionId) ??
      (await deps.projects.getVersion(ctx, current.parentVersionId)))
    : undefined;
  const parentDigests = parent ? digestsOf(parent.ir) : undefined;
  const changed = (key: string) => parentDigests === undefined || parentDigests.get(key) !== digests.get(key);

  // Rendered digests per shot, from the versions of every finished render.
  const renderedVersionIds = [
    ...new Set(renders.items.filter((r) => r.status === "succeeded").map((r) => r.versionId)),
  ];
  const renderedIrs = await Promise.all(
    renderedVersionIds.map(
      async (id) => versions.items.find((v) => v.id === id) ?? (await deps.projects.getVersion(ctx, id)),
    ),
  );
  const renderedDigests = renderedIrs.flatMap((v) => (v ? [digestsOf(v.ir)] : []));
  const renderState = (shotId: string): ShotRenderState => {
    const key = nodeKey.shot(shotId);
    if (renderedDigests.some((d) => d.get(key) === digests.get(key))) return "rendered";
    return renderedDigests.some((d) => d.has(key)) ? "outdated" : "not_rendered";
  };

  const revisions = new Map(
    (await deps.revisions.listVersionRevisions(ctx, current.id)).map((r) => [
      `${r.kind}:${r.nodeId}`,
      r.revision,
    ]),
  );
  const commentCount = new Map<string, number>();
  for (const c of comments.items) {
    if (c.targetId) commentCount.set(c.targetId, (commentCount.get(c.targetId) ?? 0) + 1);
  }

  const placements = new Map(shotPlacements(ir).map((p) => [p.shotId, p]));
  const effective = await effectiveStoryboard(deps, ctx, current);
  const sbShots = new Map(effective.storyboard.scenes.flatMap((s) => s.shots.map((t) => [t.id, t])));
  const sbScenes = new Map(effective.storyboard.scenes.map((s) => [s.id, s]));
  const scenes: ReviewScene[] = ir.scenes.map((scene) => {
    const shots = scene.shots.map((shot): ReviewShot => {
      const at = placements.get(shot.id) as ShotPlacement;
      const key = nodeKey.shot(shot.id);
      const planned = sbShots.get(shot.id);
      return {
        id: shot.id,
        kind: shot.type,
        description: planned?.description ?? shot.type,
        script: shotScript(shot),
        startMs: at.startMs,
        endMs: at.endMs,
        durationMs: shot.durationMs,
        pointer: at.pointer,
        approval: planned?.approval ?? { status: "draft" },
        render: renderState(shot.id),
        revision: revisions.get(key),
        changed: changed(key),
        comments: commentCount.get(key) ?? 0,
      };
    });
    const key = nodeKey.scene(scene.id);
    const planned = sbScenes.get(scene.id);
    return {
      id: scene.id,
      title: planned?.title ?? scene.id,
      summary: planned?.summary,
      startMs: shots.reduce((m, s) => Math.min(m, s.startMs), Number.POSITIVE_INFINITY),
      endMs: shots.reduce((m, s) => Math.max(m, s.endMs), 0),
      approval: planned?.approval ?? { status: "draft" },
      revision: revisions.get(key),
      changed: changed(key),
      shots,
    };
  });
  const allShots = scenes.flatMap((s) => s.shots);
  return {
    ...base,
    script: {
      prompt: project.brief.prompt,
      lines: allShots.flatMap((s) =>
        s.script
          ? [
              {
                sceneId: placements.get(s.id)!.sceneId,
                shotId: s.id,
                startMs: s.startMs,
                endMs: s.endMs,
                text: s.script,
              },
            ]
          : [],
      ),
    },
    timeline: {
      durationMs: ir.format.durationMs,
      fps: ir.format.fps,
      aspectRatio: ir.format.aspectRatio,
      width: ir.format.width,
      height: ir.format.height,
    },
    storyboard: {
      revision: effective.revision,
      stored: effective.stored,
      title: effective.storyboard.title,
      approval: effective.storyboard.approval,
      scenes,
      pendingShots: allShots.filter((s) => s.approval.status !== "approved").length,
    },
    invalidated: [...digests.keys()].filter(
      (k) => (k.startsWith("shot:") || k.startsWith("scene:")) && parentDigests !== undefined && changed(k),
    ),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Storyboard decisions

export interface StoryboardDecisionResult {
  storyboard: ProjectStoryboard;
  /** The reviewer's note, stored as a comment on the target. */
  comment?: Review;
}

/** Approve or request changes on the storyboard, a scene or a shot. Only a signed-in person may decide. */
export async function decideStoryboard(
  deps: Deps,
  ctx: TenantContext,
  rawInput: unknown,
): Promise<StoryboardDecisionResult> {
  assertPermission(ctx, "approval:decide");
  const input = parseInput(StoryboardDecisionInput, rawInput, "storyboard decision");
  if (ctx.actor.type !== "user") {
    throw new StudixError("FORBIDDEN", "Storyboard decisions must be made by a signed-in person", {
      suggestedAction: "Ask a workspace member to review the storyboard in the Studix dashboard.",
    });
  }
  const project = await requireProject(deps, ctx, input.projectId);
  const version = await requireCurrentVersion(deps, ctx, project);
  const effective = await effectiveStoryboard(deps, ctx, version);
  if (input.expectedRevision !== undefined && input.expectedRevision !== effective.revision) {
    throw new StudixError("CONFLICT", "storyboard changed since it was read", {
      details: { revision: effective.revision },
      suggestedAction: "Reload the review page and decide again.",
    });
  }
  const target: StoryboardTarget =
    input.target === "storyboard"
      ? { kind: "storyboard" }
      : { kind: input.target, id: input.targetId as string };
  if (input.decision === "approved" && target.kind === "storyboard") {
    const blocked = shotsWithChangesRequested(effective.storyboard);
    if (blocked.length > 0) {
      throw new StudixError("CONFLICT", `shots ${blocked.join(", ")} still have changes requested`, {
        details: { shots: blocked },
        suggestedAction: "Resolve or approve those shots before approving the storyboard.",
      });
    }
  }
  const approval: StoryboardApproval = {
    status: input.decision,
    reviewer: ctx.actor.id,
    decidedAt: deps.clock.now().toISOString(),
    ...(input.note ? { note: input.note } : {}),
  };
  const createdBy = actorRef(ctx.actor);
  const stored = await deps.storyboards.append(ctx, {
    projectId: project.id,
    versionId: version.id,
    revision: effective.revision + 1,
    storyboard: setStoryboardApproval(effective.storyboard, target, approval),
    createdBy,
  });
  const comment = input.note
    ? await deps.reviews.create(ctx, {
        projectId: project.id,
        versionId: version.id,
        author: createdBy,
        body: input.note,
        targetId: storyboardTargetKey(target),
      })
    : undefined;
  await deps.audit.append(ctx, {
    actor: createdBy,
    action: `storyboard.${input.decision}`,
    subjectType: "project",
    subjectId: project.id,
    data: { target: storyboardTargetKey(target), revision: stored.revision, versionId: version.id },
  });
  return { storyboard: stored, comment };
}

// ---------------------------------------------------------------------------------------------------------
// Feedback and render

interface ResolvedTarget {
  /** Comment anchor (node key); undefined for a time range. */
  key?: string;
  /** JSON pointers a patch may touch. */
  allowedPaths: string[];
  /** Shots the feedback is about. */
  shots: string[];
}

function resolveTarget(ir: VideoIR, input: FeedbackInputParsed): ResolvedTarget {
  const placements = shotPlacements(ir);
  if (input.shotId !== undefined) {
    const at = placements.find((p) => p.shotId === input.shotId);
    if (!at) throw notInVersion("shot", input.shotId);
    return { key: nodeKey.shot(at.shotId), allowedPaths: [at.pointer], shots: [at.shotId] };
  }
  if (input.sceneId !== undefined) {
    const index = ir.scenes.findIndex((s) => s.id === input.sceneId);
    if (index < 0) throw notInVersion("scene", input.sceneId);
    return {
      key: nodeKey.scene(input.sceneId),
      // A scene's duration lives in the timeline too, so a scene patch may re-time it.
      allowedPaths: [`/scenes/${index}`, "/timeline"],
      shots: ir.scenes[index]!.shots.map((s) => s.id),
    };
  }
  if (input.assetId !== undefined) {
    const index = ir.assets.findIndex((a) => a.id === input.assetId);
    if (index < 0) throw notInVersion("asset", input.assetId);
    const affected = dependentsOf(videoIrNodes(ir), [nodeKey.asset(input.assetId)]);
    return {
      key: nodeKey.asset(input.assetId),
      allowedPaths: [`/assets/${index}`],
      shots: placements.filter((p) => affected.has(nodeKey.shot(p.shotId))).map((p) => p.shotId),
    };
  }
  const startMs = input.startMs as number;
  const endMs = input.endMs as number;
  if (startMs >= ir.format.durationMs) {
    throw new StudixError(
      "VALIDATION",
      `startMs ${startMs} is past the end of the video (${ir.format.durationMs} ms)`,
    );
  }
  const hit = placements.filter((p) => p.startMs < endMs && p.endMs > startMs);
  return { allowedPaths: hit.map((p) => p.pointer), shots: hit.map((p) => p.shotId) };
}

function notInVersion(kind: string, id: string): StudixError {
  return new StudixError("NOT_FOUND", `${kind} ${id} is not in the current version`, {
    suggestedAction: "Call studix_get_project with includeIr to list scene, shot and asset ids.",
  });
}

function within(pointer: string, allowed: string[]): boolean {
  return allowed.some((prefix) => pointer === prefix || pointer.startsWith(`${prefix}/`));
}

function assertPatchScope(patch: VideoIRPatch, allowedPaths: string[]): void {
  const outside = patch.ops.flatMap((op) =>
    [op.path, "from" in op ? op.from : undefined].filter(
      (p): p is string => p !== undefined && !within(p, allowedPaths),
    ),
  );
  if (outside.length > 0) {
    throw new StudixError(
      "VALIDATION",
      `patch touches paths outside the feedback target: ${outside.join(", ")}`,
      {
        details: { outside, allowedPaths },
        suggestedAction:
          "Only change the targeted shot, scene or asset; send other changes as separate feedback.",
      },
    );
  }
}

type FeedbackInputParsed = ReturnType<typeof FeedbackInput.parse>;

export interface FeedbackResult {
  feedbackId: string;
  projectId: string;
  /** Version the feedback was written against. */
  baseVersionId: string;
  /** New version produced by the patch; absent for a comment without a patch. */
  versionId?: string;
  version?: number;
  /** Node keys the patch invalidated (only these are re-generated; the rest is reused). */
  invalidated: string[];
  /** Shots the feedback is about. */
  shots: string[];
  /** Pointers a patch for this target may touch. */
  allowedPaths: string[];
  job?: JobView;
  approval?: Approval;
  replayed: boolean;
  next: NextAction[];
}

/**
 * Feedback on a shot, scene, asset or time range. Always stored as a comment on the version it was written
 * against. With a patch, the patch (scoped to the target) produces a new immutable version whose scene/shot
 * revisions are recorded, and a render job is queued: only nodes depending on the change get new digests,
 * so cached stage work for everything else is reused.
 */
export async function submitFeedback(
  deps: Deps,
  ctx: TenantContext,
  rawInput: unknown,
): Promise<FeedbackResult> {
  const input = parseInput(FeedbackInput, rawInput, "feedback");
  if (input.patch) assertPermission(ctx, "project:write");
  else assertCanComment(ctx);
  const project = await requireProject(deps, ctx, input.projectId);

  const replay = await replayVersionJob(deps, ctx, input.idempotencyKey);
  if (replay) {
    const payload = replay.raw.payload;
    if (replay.raw.projectId !== project.id) {
      throw new StudixError("CONFLICT", "idempotency key belongs to another project's job");
    }
    return {
      feedbackId: String(payload.feedbackId ?? ""),
      projectId: project.id,
      baseVersionId: String(payload.baseVersionId ?? ""),
      versionId: typeof payload.versionId === "string" ? payload.versionId : undefined,
      invalidated: [],
      shots: [],
      allowedPaths: [],
      job: replay.job,
      replayed: true,
      next: replay.job.next,
    };
  }

  const base = await requireCurrentVersion(deps, ctx, project);
  if (input.baseVersionId !== undefined && input.baseVersionId !== base.id) {
    throw new StudixError("CONFLICT", `version ${input.baseVersionId} is no longer current`, {
      details: { currentVersionId: base.id },
      suggestedAction: "Review the current version and send the feedback against it.",
    });
  }
  const target = resolveTarget(base.ir, input);
  if (input.patch) assertPatchScope(input.patch, target.allowedPaths);
  // Validate the patched IR before anything is stored.
  const nextIr = input.patch ? applyPatch(base.ir, input.patch) : undefined;

  const author = actorRef(ctx.actor);
  // The version is created first, advancing the project's current version only if `base` is still current.
  // A concurrent request on the same base loses here with CONFLICT, before it stores a comment or a job.
  const version =
    nextIr && input.patch
      ? await deps.projects.createVersion(ctx, {
          projectId: project.id,
          ir: nextIr,
          source: "patch",
          parentVersionId: base.id,
          patch: {
            description: input.patch.description ?? input.comment.slice(0, 500),
            ops: input.patch.ops,
          },
          createdBy: author,
          advanceFrom: base.id,
        })
      : undefined;
  const feedback = await deps.reviews.create(ctx, {
    projectId: project.id,
    versionId: base.id,
    author,
    body: input.comment,
    targetId: target.key,
    atMs: input.startMs,
    endMs: input.endMs,
  });
  const common = {
    feedbackId: feedback.id,
    projectId: project.id,
    baseVersionId: base.id,
    shots: target.shots,
    allowedPaths: target.allowedPaths,
    replayed: false,
  };
  if (!version) {
    const example = target.allowedPaths[0];
    return {
      ...common,
      invalidated: [],
      next: example
        ? [
            {
              tool: STUDIX_TOOLS.feedback,
              arguments: {
                projectId: project.id,
                ...(input.shotId ? { shotId: input.shotId } : {}),
                ...(input.sceneId ? { sceneId: input.sceneId } : {}),
                ...(input.assetId ? { assetId: input.assetId } : {}),
                ...(input.startMs !== undefined ? { startMs: input.startMs, endMs: input.endMs } : {}),
                comment: input.comment,
                baseVersionId: base.id,
                patch: { ops: [{ op: "replace", path: `${example}/...`, value: "..." }] },
              },
              reason: `Comment saved. To apply it, send patch ops under ${target.allowedPaths.join(", ")}.`,
            },
          ]
        : [],
    };
  }

  await deps.revisions.recordVersion(ctx, base.id);
  const recorded = await deps.revisions.recordVersion(ctx, version.id);
  const queued = await enqueueVersionJob(deps, ctx, {
    project,
    version,
    renderPreset: input.renderPreset,
    idempotencyKey: input.idempotencyKey,
    budgetCents: input.budgetCents,
    extra: { feedbackId: feedback.id, baseVersionId: base.id },
  });
  await deps.audit.append(ctx, {
    actor: author,
    action: "project.feedback_applied",
    subjectType: "project",
    subjectId: project.id,
    data: {
      feedbackId: feedback.id,
      versionId: version.id,
      invalidated: recorded.invalidated,
      jobId: queued.job.id,
    },
  });
  return {
    ...common,
    versionId: version.id,
    version: version.version,
    invalidated: recorded.invalidated,
    job: queued.job,
    approval: queued.approval,
    replayed: queued.replayed,
    next: queued.job.next,
  };
}

export interface RenderResult {
  projectId: string;
  versionId: string;
  version: number;
  job: JobView;
  approval?: Approval;
  replayed: boolean;
  next: NextAction[];
}

/** Queue a render of a stored version (default: the current one). The rendered version becomes current. */
export async function renderVersion(
  deps: Deps,
  ctx: TenantContext,
  rawInput: unknown,
): Promise<RenderResult> {
  assertPermission(ctx, "project:write");
  const input = parseInput(RenderVersionInput, rawInput, "render request");
  const project = await requireProject(deps, ctx, input.projectId);
  const replay = await replayVersionJob(deps, ctx, input.idempotencyKey);
  if (replay) {
    if (replay.raw.projectId !== project.id)
      throw new StudixError("CONFLICT", "idempotency key belongs to another project's job");
    const versionId = String(replay.raw.payload.versionId ?? "");
    const version = await deps.projects.getVersion(ctx, versionId);
    return {
      projectId: project.id,
      versionId,
      version: version?.version ?? 0,
      job: replay.job,
      replayed: true,
      next: replay.job.next,
    };
  }
  const version = input.versionId
    ? await deps.projects.getVersion(ctx, input.versionId)
    : await requireCurrentVersion(deps, ctx, project);
  if (!version || version.projectId !== project.id)
    throw new StudixError("NOT_FOUND", `project version ${input.versionId} not found`);
  await deps.revisions.recordVersion(ctx, version.id);
  const queued = await enqueueVersionJob(deps, ctx, {
    project,
    version,
    renderPreset: input.renderPreset,
    idempotencyKey: input.idempotencyKey,
    budgetCents: input.budgetCents,
  });
  return {
    projectId: project.id,
    versionId: version.id,
    version: version.version,
    job: queued.job,
    approval: queued.approval,
    replayed: queued.replayed,
    next: queued.job.next,
  };
}
