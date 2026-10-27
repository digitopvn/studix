import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { USAGE_KINDS } from "@studix/billing";
import {
  JOB_KINDS,
  type ProjectRepository,
  type RendererAdapter,
  type RenderRepository,
  type StorageAdapter,
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
} from "./video-create-checkpoints.ts";
import type { Planner, StageResult, WorkflowDefinition } from "./workflow-types.ts";

export const VIDEO_CREATE_STAGES = ["plan", "validate_ir", "render", "upload", "finalize"] as const;

export interface VideoCreateWorkflowDeps {
  planner: Planner;
  renderer: RendererAdapter;
  storage: StorageAdapter;
  /** Read-only: writes go through `StageContext.fenced`. */
  projects: Pick<ProjectRepository, "get" | "getVersion">;
  renders: Pick<RenderRepository, "get">;
  /** Local scratch root; each job attempt renders into `<workRoot>/<jobId>/attempt-<n>`. */
  workRoot: string;
  /** COGS per rendered output second (compute cost). Defaults to 0 until measured. */
  renderCentsPerSecond?: number;
  clock?: Clock;
}

/** `video.create`: plan -> validate_ir -> render -> upload -> finalize, each stage checkpointed. */
export function createVideoCreateWorkflow(deps: VideoCreateWorkflowDeps): WorkflowDefinition {
  const rate = deps.renderCentsPerSecond ?? 0;
  if (!Number.isFinite(rate) || rate < 0) throw new RangeError("renderCentsPerSecond must be >= 0");
  const clock = deps.clock ?? systemClock;
  const jobDir = (jobId: string) => join(deps.workRoot, jobId);

  return {
    kind: JOB_KINDS.createVideo,
    result: (outputs) => outputs.finalize ?? {},
    stages: [
      {
        name: "plan",
        async run(s): Promise<StageResult> {
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
      },
      {
        name: "validate_ir",
        async run(s) {
          const ir = irOf(s);
          const planned = read(PlanOutput, s.outputs.plan, "plan checkpoint");
          const payload = payloadOf(s);
          // Deterministic id: a re-run after a crash finds the version instead of adding another.
          const versionId = planned.versionId ?? jobScopedId("pver", s.job.id);
          const missing = !planned.versionId && !(await deps.projects.getVersion(s.ctx, versionId));
          await s.fenced(async (r) => {
            if (missing) {
              await r.projects.createVersion(s.ctx, {
                id: versionId,
                projectId: payload.projectId,
                ir,
                source: "planner",
                createdBy: { type: "system", id: s.ctx.actor.id },
              });
            }
            await r.projects.update(s.ctx, payload.projectId, {
              currentVersionId: versionId,
              status: "rendering",
            });
          });
          return { output: { versionId } };
        },
      },
      {
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
      },
      {
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
      },
      {
        name: "finalize",
        async run(s) {
          const payload = payloadOf(s);
          const rendered = read(RenderOutput, s.outputs.render, "render checkpoint");
          const uploaded = read(UploadOutput, s.outputs.upload, "upload checkpoint");
          const { versionId } = read(ValidateOutput, s.outputs.validate_ir, "validate_ir checkpoint");
          const renderId = jobScopedId("rnd", s.job.id);
          const spec = resolveRenderSpec(payload.renderPreset);
          const existing = await deps.renders.get(s.ctx, renderId);
          await s.fenced(async (r) => {
            if (!existing) {
              await r.renders.create(s.ctx, {
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
            await r.projects.update(s.ctx, payload.projectId, { status: "in_review" });
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
      },
    ],
  };
}
