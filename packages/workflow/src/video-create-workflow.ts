import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { USAGE_KINDS } from "@studix/billing";
import {
  JOB_KINDS,
  type ProjectRepository,
  type RendererAdapter,
  type RenderRepository,
  type StorageAdapter,
  type TenantContext,
} from "@studix/core";
import { type Clock, StudixError, systemClock } from "@studix/shared";
import { resolveRenderSpec } from "@studix/video-ir";
import { fileExists, jobScopedId, sha256File } from "./file-digest.ts";
import { downloadIrAssets } from "./ir-asset-download.ts";
import {
  irOf,
  PlanOutput,
  payloadOf,
  RenderOutput,
  read,
  UploadOutput,
  ValidateOutput,
  VideoCreatePayload,
} from "./video-create-checkpoints.ts";
import type { FencedRepositories } from "./worker-job-queue.ts";
import type {
  EngineStages,
  PackPipeline,
  Planner,
  StageDefinition,
  StageOutput,
  WorkflowDefinition,
} from "./workflow-types.ts";

export const VIDEO_CREATE_STAGES = ["plan", "validate_ir", "render", "upload", "finalize"] as const;

export interface VideoCreateWorkflowDeps {
  planner: Planner;
  renderer: RendererAdapter;
  storage: StorageAdapter;
  /** Read side only: every write goes through `StageContext.commit` so it is fenced by job ownership. */
  projects: Pick<ProjectRepository, "get" | "getVersion">;
  renders: Pick<RenderRepository, "get">;
  /** Local scratch root; each job attempt renders into `<workRoot>/<jobId>/attempt-<n>`. */
  workRoot: string;
  /** COGS per rendered output second (compute cost). Defaults to 0 until measured. */
  renderCentsPerSecond?: number;
  clock?: Clock;
  /**
   * The pipeline of a job's workflow pack (by `workflowTemplate`), or undefined for packs that run the
   * default chain. Called once per attempt; a throw (an unknown pack) fails the job before any stage runs.
   */
  pipelines?(workflowTemplate: string | undefined): PackPipeline | undefined;
}

const defaultResult = (outputs: Readonly<Record<string, StageOutput>>) =>
  outputs.finalize ?? outputs.storyboard_ready ?? {};

/** The engine stages of `video.create`; packs assemble their pipelines from these. */
export function createVideoCreateStages(deps: VideoCreateWorkflowDeps): EngineStages {
  const rate = deps.renderCentsPerSecond ?? 0;
  if (!Number.isFinite(rate) || rate < 0) throw new RangeError("renderCentsPerSecond must be >= 0");
  const clock = deps.clock ?? systemClock;
  const jobDir = (jobId: string) => join(deps.workRoot, jobId);

  const brief: StageDefinition = {
    name: "brief",
    async run(s) {
      const payload = payloadOf(s);
      const project = await deps.projects.get(s.ctx, payload.projectId);
      if (!project)
        throw new StudixError("NOT_FOUND", `project ${payload.projectId} not found`, { retryable: false });
      return { output: { brief: project.brief } };
    },
  };

  const plan: StageDefinition = {
    name: "plan",
    async run(s) {
      const payload = payloadOf(s);
      if (payload.versionId) {
        const version = await deps.projects.getVersion(s.ctx, payload.versionId);
        if (!version || version.projectId !== payload.projectId) {
          throw new StudixError("NOT_FOUND", `project version ${payload.versionId} not found`, {
            retryable: false,
          });
        }
        return { output: { ir: version.ir, versionId: version.id } };
      }
      const project = await deps.projects.get(s.ctx, payload.projectId);
      if (!project)
        throw new StudixError("NOT_FOUND", `project ${payload.projectId} not found`, {
          retryable: false,
        });
      const remaining =
        s.job.budgetCents === undefined ? undefined : Math.max(0, s.job.budgetCents - s.job.spentCents);
      const planned = await deps.planner(
        project.brief,
        {
          tenant: s.ctx,
          jobId: s.job.id,
          projectId: project.id,
          attempt: s.attempt,
          maxCostCents: remaining,
          requestedBy: s.job.createdBy,
          planner: payload.planner,
          workflowTemplate: payload.workflowTemplate,
        },
        s.signal,
      );
      return {
        output: { ir: planned.ir },
        usage: planned.usage.map((u, i) => ({
          item: `decision-${i}`,
          kind: USAGE_KINDS.providerDecision,
          quantity: 1,
          unit: "call",
          costCents: u.costCents,
          providerExecutionId: u.providerExecutionId,
          metadata: {
            provider: u.provider,
            model: u.model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            latencyMs: u.latencyMs,
            operation: u.operation,
          },
        })),
      };
    },
  };

  /** Move the project to review, unless a newer version became head: that version's own job settles it. */
  const settleProjectInReview = async (
    repos: Pick<FencedRepositories, "projects">,
    ctx: TenantContext,
    projectId: string,
    versionId: string,
  ) => {
    const project = await repos.projects.get(ctx, projectId);
    if (project?.currentVersionId !== undefined && project.currentVersionId !== versionId) return;
    await repos.projects.update(ctx, projectId, { status: "in_review" });
  };

  const validateIr: StageDefinition = {
    name: "validate_ir",
    async run(s) {
      const ir = irOf(s);
      // Pack pipelines may compose the IR in their own stages, without a plan stage.
      const planned: { versionId?: string } =
        s.outputs.plan === undefined ? {} : read(PlanOutput, s.outputs.plan, "plan checkpoint");
      const payload = payloadOf(s);
      // Deterministic id: a re-run after a crash finds the version instead of adding another.
      const newVersionId = planned.versionId ? undefined : jobScopedId("pver", s.job.id);
      const versionId = planned.versionId ?? (newVersionId as string);
      const needsVersion = newVersionId !== undefined && !(await deps.projects.getVersion(s.ctx, versionId));
      // One commit: the version and the project pointing at it land together or not at all.
      await s.commit(async (repos, ctx) => {
        if (needsVersion) {
          await repos.projects.createVersion(ctx, {
            id: versionId,
            projectId: payload.projectId,
            ir,
            source: "planner",
            createdBy: { type: "system", id: ctx.actor.id },
          });
        }
        // By the time a queued job runs a newer version may be head; jobs that did not ask to move it
        // (feedback patches, renders of "the current version") must not silently revert it.
        const movesHead = payload.makeCurrent && !payload.feedbackId;
        const project = await repos.projects.get(ctx, payload.projectId);
        const isHead = movesHead || project?.currentVersionId === versionId;
        // Only the job of the head version owns the project's status: another job's render must not flag it.
        await repos.projects.update(ctx, payload.projectId, {
          ...(movesHead ? { currentVersionId: versionId } : {}),
          ...(isHead ? { status: "rendering" as const } : {}),
        });
      });
      return { output: { versionId } };
    },
  };

  const render: StageDefinition = {
    name: "render",
    estimateCostCents: (s) => (irOf(s).format.durationMs / 1000) * rate,
    // The render file is local to the worker that produced it; after a move to another worker it is
    // only needed again if the upload has not been checkpointed yet.
    isCheckpointValid: (output, saved) => {
      const parsed = RenderOutput.safeParse(output);
      if (!parsed.success) return false;
      return saved.upload !== undefined || fileExists(parsed.data.filePath);
    },
    async run(s) {
      const ir = irOf(s);
      const spec = resolveRenderSpec(payloadOf(s).renderPreset);
      const support = deps.renderer.supports(ir, spec);
      if (!support.supported) {
        throw new StudixError("VALIDATION", `Renderer ${deps.renderer.id} cannot render this video`, {
          retryable: false,
          details: { reasons: support.reasons },
        });
      }
      const workDir = join(jobDir(s.job.id), `attempt-${s.attempt}`);
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      const assetFiles = await downloadIrAssets(deps.storage, s.ctx, ir, join(workDir, "assets"));
      const out = await deps.renderer.render(ir, {
        spec,
        workDir,
        assetFiles,
        signal: s.signal,
        onProgress: (p) => s.reportProgress(p.progress),
      });
      const seconds = out.probe.durationMs / 1000;
      return {
        output: { filePath: out.filePath, mime: out.mime, probe: out.probe },
        usage: [
          {
            item: "render",
            kind: USAGE_KINDS.renderSeconds,
            quantity: seconds,
            unit: "s",
            costCents: seconds * rate,
            metadata: { renderer: deps.renderer.id, preset: spec.preset },
          },
        ],
      };
    },
  };

  const upload: StageDefinition = {
    name: "upload",
    async run(s) {
      const rendered = read(RenderOutput, s.outputs.render, "render checkpoint");
      const { sha256, bytes } = await sha256File(rendered.filePath);
      const renderId = jobScopedId("rnd", s.job.id);
      const key = `renders/${renderId}/${payloadOf(s).renderPreset}.mp4`;
      const stored = await deps.storage.put(
        s.ctx,
        key,
        { filePath: rendered.filePath },
        { contentType: rendered.mime, sha256 },
      );
      return {
        output: { storageKey: stored.key, bytes: stored.bytes, sha256: stored.sha256 },
        usage: [
          {
            item: "upload",
            kind: USAGE_KINDS.storageBytes,
            quantity: bytes,
            unit: "byte",
            costCents: 0,
            metadata: { key },
          },
        ],
      };
    },
  };

  const finalize: StageDefinition = {
    name: "finalize",
    async run(s) {
      const payload = payloadOf(s);
      const rendered = read(RenderOutput, s.outputs.render, "render checkpoint");
      const uploaded = read(UploadOutput, s.outputs.upload, "upload checkpoint");
      const { versionId } = read(ValidateOutput, s.outputs.validate_ir, "validate_ir checkpoint");
      const renderId = jobScopedId("rnd", s.job.id);
      const spec = resolveRenderSpec(payload.renderPreset);
      const existing = await deps.renders.get(s.ctx, renderId);
      await s.commit(async (repos, ctx) => {
        if (!existing) {
          await repos.renders.create(ctx, {
            id: renderId,
            projectId: payload.projectId,
            versionId,
            jobId: s.job.id,
            preset: spec.preset,
            spec,
            status: "succeeded",
            storageKey: uploaded.storageKey,
            probe: { ...rendered.probe, bytes: uploaded.bytes },
            completedAt: clock.now(),
          });
        }
        await settleProjectInReview(repos, ctx, payload.projectId, versionId);
      });
      await rm(jobDir(s.job.id), { recursive: true, force: true });
      return {
        output: {
          renderId,
          projectVersionId: versionId,
          storageKey: uploaded.storageKey,
          sha256: uploaded.sha256,
          bytes: uploaded.bytes,
        },
      };
    },
  };

  const storyboardReady: StageDefinition = {
    name: "storyboard_ready",
    async run(s) {
      const payload = payloadOf(s);
      const { versionId } = read(ValidateOutput, s.outputs.validate_ir, "validate_ir checkpoint");
      await s.commit(async (repos, ctx) => {
        await settleProjectInReview(repos, ctx, payload.projectId, versionId);
      });
      await rm(jobDir(s.job.id), { recursive: true, force: true });
      return { output: { projectVersionId: versionId, storyboard: "in_review" } };
    },
  };

  return { brief, plan, validateIr, render, upload, finalize, storyboardReady };
}

/**
 * `video.create`: plan -> validate_ir -> render -> upload -> finalize, each stage checkpointed. A job whose
 * workflow pack has a pipeline runs that pipeline's stages instead, assembled from the same engine stages.
 */
export function createVideoCreateWorkflow(deps: VideoCreateWorkflowDeps): WorkflowDefinition {
  const engine = createVideoCreateStages(deps);
  return {
    kind: JOB_KINDS.createVideo,
    result: defaultResult,
    stages: [engine.plan, engine.validateIr, engine.render, engine.upload, engine.finalize],
    route(job) {
      if (!deps.pipelines) return undefined;
      const payload = read(VideoCreatePayload, job.payload, "video.create job payload", "VALIDATION");
      const pipeline = deps.pipelines(payload.workflowTemplate);
      if (!pipeline) return undefined;
      if (pipeline.renderer !== undefined && pipeline.renderer !== deps.renderer.id) {
        throw new StudixError(
          "UNAVAILABLE",
          `Workflow ${payload.workflowTemplate} renders with ${pipeline.renderer}; this worker has ${deps.renderer.id}`,
          { retryable: false, details: { workflowTemplate: payload.workflowTemplate } },
        );
      }
      return {
        stages: pipeline.stages(
          {
            fromVersion: payload.versionId !== undefined,
            feedback: payload.versionId !== undefined && payload.feedbackId !== undefined,
          },
          engine,
        ),
        result: pipeline.result ?? defaultResult,
      };
    },
  };
}
