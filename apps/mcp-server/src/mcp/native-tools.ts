import {
  type FeedbackInput,
  type NextAction,
  PlannerSelection,
  RenderVersionInput,
  resolveWorkflowPack,
  STUDIX_TOOLS,
  type TenantContext,
  WorkflowTemplateId,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { packRegistry } from "@studix/skills";
import { RenderPreset } from "@studix/video-ir";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { type ArtifactUrlDeps, isPlayable, signRender } from "../artifact-urls.ts";
import { assertPlannerSelection } from "../planner-selection.ts";
import { jobWithVideo, projectView } from "../resource-views.ts";
import { INSPECT_SECTIONS, inspectCapabilities } from "./inspect-capabilities.ts";

/** Native tool names. `studix_cancel_job` is not referenced by core next-hints, so it is named here. */
export const NATIVE_TOOL_NAMES = {
  ...STUDIX_TOOLS,
  cancelJob: "studix_cancel_job",
  retryJob: "studix_retry_job",
  attachMediaJob: "studix_attach_media_job",
} as const;

export interface ToolContext {
  deps: AppDeps;
  artifacts: ArtifactUrlDeps;
  tenant: TenantContext;
  traceId: string;
  /** Names of every tool listed on this server (for the inspect handshake). */
  toolNames: string[];
}

export interface ToolOutcome {
  data: object;
  next: NextAction[];
  /** Job/project ids for the activity trail. */
  scope?: { jobId?: string; projectId?: string };
}

export interface NativeTool<I extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  readOnly: boolean;
  destructive?: boolean;
  /** Repeating the call with the same input changes nothing more. Read-only tools always are. */
  idempotent?: boolean;
  /** The tool contacts services outside Studix (the MCP `openWorldHint`). */
  openWorld?: boolean;
  /** Mutations are recorded in the workspace activity trail. */
  audited?: boolean;
  run(ctx: ToolContext, input: z.output<I>): Promise<ToolOutcome>;
}

function tool<I extends z.ZodType>(def: NativeTool<I>): NativeTool<I> {
  return def;
}

/** Dashboard page where a person reviews and approves the project's storyboard and shots. */
export function reviewUrl(deps: Pick<AppDeps, "appUrl">, projectId: string): string {
  return `${deps.appUrl}/#/projects/${encodeURIComponent(projectId)}/review`;
}

/** Signed preview URL of the newest finished render of a project, when storage can sign one. */
async function latestPreview(ctx: ToolContext, projectId: string): Promise<string | undefined> {
  const renders = await ctx.artifacts.renders.listByProject(ctx.tenant, projectId, { limit: 20 });
  const render = renders.items.find(isPlayable);
  if (!render) return undefined;
  const signed = await signRender(ctx.artifacts, ctx.tenant, render).catch(() => undefined);
  return signed?.url;
}

const Id = z.string().trim().min(1).max(100);

const CreateVideoInput = z
  .object({
    prompt: z.string().trim().min(1).max(4000).optional().describe("Goal in natural language (vi or en)."),
    brief: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("CreativeBrief object (schema via studix_inspect include=schemas); overrides prompt."),
    spec: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Complete VideoIR from the host; skips planning."),
    title: z.string().trim().min(1).max(200).optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,200}$/)
      .optional()
      .describe("Same key in this workspace returns the original job."),
    budgetCents: z.number().int().min(0).max(10_000_000).optional(),
    deadlineSeconds: z
      .number()
      .int()
      .min(10)
      .max(7 * 24 * 3600)
      .optional()
      .describe("Seconds from now until the job fails with TIMEOUT."),
    renderPreset: RenderPreset.optional(),
    planner: PlannerSelection.optional().describe(
      "Opt-in Claude planner: an Anthropic key connection id (dashboard, AI & Providers). Not with spec.",
    ),
    workflowTemplate: WorkflowTemplateId.optional().describe(
      "Workflow pack id (studix_inspect skills). Default brand-intro.",
    ),
    // Where creative agent stages run: in Studix (harness, the default) or on the host's agent through the
    // agent task tools. Left undescribed on the wire to keep the tool list within its size budget.
    agentMode: z.enum(["harness", "host"]).optional(),
  })
  .refine((v) => v.prompt !== undefined || v.brief !== undefined, {
    message: "Provide prompt or brief",
    path: ["prompt"],
  });

const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,200}$/)
  .optional();
const Ms = z.number().int().min(0).max(600_000).optional();

/**
 * Compact wire schema for feedback: the tool list stays small, and StudioService re-validates the call
 * against the full `FeedbackInput` (one target, pointer syntax, patch shape) before anything is stored.
 */
const FeedbackToolInput = z.object({
  projectId: Id,
  shotId: Id.optional().describe(
    "Shot; in a film, a shot, scene or time-range patch may also rewrite its SFX cues.",
  ),
  sceneId: Id.optional(),
  assetId: Id.optional(),
  characterId: Id.optional().describe("Film character; a patch may only change its voice."),
  startMs: Ms.describe("Time range start; with endMs instead of an id."),
  endMs: Ms,
  comment: z.string().trim().min(1).max(2000),
  patch: z
    .object({
      description: z.string().max(500).optional(),
      ops: z
        .array(
          z.object({
            op: z.enum(["add", "remove", "replace", "move", "copy", "test"]),
            path: z.string().max(500),
            from: z.string().max(500).optional(),
            value: z.unknown().optional(),
          }),
        )
        .min(1)
        .max(500),
    })
    .optional()
    .describe("JSON Patch on the VideoIR; paths must stay inside the target (see allowedPaths)."),
  baseVersionId: Id.optional(),
  renderPreset: RenderPreset.optional(),
  idempotencyKey: IdempotencyKey,
  budgetCents: z.number().int().min(0).max(10_000_000).optional(),
});

export const NATIVE_TOOLS = [
  tool({
    name: NATIVE_TOOL_NAMES.inspect,
    title: "Inspect Studix capabilities",
    description:
      "Capabilities handshake: versions, formats, limits, workflow templates. include=['schemas'] adds JSON Schemas. Call first.",
    input: z.object({ include: z.array(z.enum(INSPECT_SECTIONS)).max(4).optional() }),
    readOnly: true,
    async run(ctx, input) {
      const data = inspectCapabilities({
        tenant: ctx.tenant,
        limits: ctx.deps.limits,
        skills: ctx.deps.skills ?? [],
        toolNames: ctx.toolNames,
        importedSkills: ctx.deps.externalSkills !== undefined,
        include: input.include ?? [],
      });
      return { data, next: [] };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.createVideo,
    title: "Create video",
    description:
      "Start an async video job from a prompt, brief or validated VideoIR spec. Returns projectId and jobId fast; poll studix_get_job.",
    input: CreateVideoInput,
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const brief = input.brief ?? { prompt: input.prompt };
      const pack = resolveWorkflowPack(packRegistry, input.workflowTemplate);
      if (input.spec === undefined) await assertPlannerSelection(ctx.deps, ctx.tenant, input.planner);
      const result = await ctx.deps.studio.createVideoProject(ctx.tenant, {
        brief: brief as { prompt: string },
        spec: input.spec,
        title: input.title,
        idempotencyKey: input.idempotencyKey,
        budgetCents: input.budgetCents,
        ...(input.deadlineSeconds ? { deadlineAt: new Date(Date.now() + input.deadlineSeconds * 1000) } : {}),
        renderPreset: input.renderPreset,
        planner: input.planner,
        workflowTemplate: pack.id,
        agentMode: input.agentMode,
      });
      return {
        data: {
          projectId: result.project.id,
          jobId: result.job.id,
          workflowTemplate: result.project.workflowTemplate ?? pack.id,
          status: result.job.status,
          stage: result.job.stage ?? null,
          replayed: result.replayed,
          ...(result.approval ? { approval: result.job.approval } : {}),
          reviewUrl: reviewUrl(ctx.deps, result.project.id),
        },
        next: result.next,
        scope: { jobId: result.job.id, projectId: result.project.id },
      };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.getJob,
    title: "Get job",
    description:
      "Job status, stages, progress, error with suggestedAction, and a signed MP4 URL once succeeded.",
    input: z.object({ jobId: Id }),
    readOnly: true,
    async run(ctx, input) {
      const job = await ctx.deps.studio.getJob(ctx.tenant, input.jobId);
      const view = await jobWithVideo(ctx.artifacts, ctx.tenant, job);
      const data = job.projectId ? { ...view, reviewUrl: reviewUrl(ctx.deps, job.projectId) } : view;
      return { data, next: job.next };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.getProject,
    title: "Get project",
    description:
      "Project, current version, recent jobs and renders with signed URLs. includeIr adds the VideoIR.",
    input: z.object({ projectId: Id, includeIr: z.boolean().optional() }),
    readOnly: true,
    async run(ctx, input) {
      const details = await ctx.deps.studio.getProject(ctx.tenant, input.projectId);
      const view = await projectView(ctx.artifacts, ctx.tenant, details, {
        includeIr: input.includeIr ?? false,
      });
      const data = { ...view, reviewUrl: reviewUrl(ctx.deps, details.project.id) };
      return { data, next: details.jobs[0]?.next ?? [] };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.cancelJob,
    title: "Cancel job",
    description: "Cancel a queued job now, or ask a running job to stop at its next stage boundary.",
    input: z.object({ jobId: Id, reason: z.string().trim().max(500).optional() }),
    readOnly: false,
    destructive: true,
    audited: true,
    async run(ctx, input) {
      const job = await ctx.deps.studio.cancelJob(ctx.tenant, input.jobId, input.reason);
      return { data: job, next: job.next, scope: { jobId: job.id, projectId: job.projectId } };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.retryJob,
    title: "Retry failed job",
    description:
      "Requeue a failed job after its cause is fixed. Same job: finished stages and paid media calls are reused, decided gates are not asked again.",
    input: z.object({ jobId: Id }),
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const job = await ctx.deps.studio.retryJob(ctx.tenant, input.jobId);
      return { data: job, next: job.next, scope: { jobId: job.id, projectId: job.projectId } };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.attachMediaJob,
    title: "Attach Atlas prediction",
    description:
      "Operators only. Failed job whose Atlas call 'may already have been charged': attach the call's prediction id from `multix history`, then retry the job to collect it unpaid.",
    input: z.object({
      jobId: Id,
      stage: z.string().trim().min(1).max(100),
      idempotencyKey: z.string().trim().min(1).max(500).describe("From the error details."),
      predictionId: z.string().trim().min(1).max(128),
    }),
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const { job, mediaJob } = await ctx.deps.studio.attachMediaJob(ctx.tenant, input);
      return {
        data: { job, mediaJob },
        next: job.next,
        scope: { jobId: job.id, projectId: job.projectId },
      };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.feedback,
    title: "Feedback on a shot, scene, asset, character voice or time range",
    description:
      "Comment on shotId, sceneId, assetId, characterId or startMs+endMs. A patch in it makes a new version and render job; a note on a design at a waiting gate redraws it.",
    input: FeedbackToolInput,
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      // The compact wire shape is looser than FeedbackInput; the service parses it with the full schema.
      const out = await ctx.deps.studio.submitFeedback(ctx.tenant, input as FeedbackInput);
      const preview = out.job ? undefined : await latestPreview(ctx, out.projectId);
      return {
        data: {
          feedbackId: out.feedbackId,
          projectId: out.projectId,
          baseVersionId: out.baseVersionId,
          versionId: out.versionId ?? null,
          version: out.version ?? null,
          jobId: out.job?.id ?? null,
          status: out.job?.status ?? null,
          replayed: out.replayed,
          invalidated: out.invalidated,
          shots: out.shots,
          allowedPaths: out.allowedPaths,
          ...(out.approval ? { approval: out.job?.approval ?? out.approval } : {}),
          reviewUrl: reviewUrl(ctx.deps, out.projectId),
          ...(preview ? { previewUrl: preview } : {}),
        },
        next: out.next,
        scope: { projectId: out.projectId, jobId: out.job?.id },
      };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.render,
    title: "Render a version",
    description:
      "Queue a render of the current or a given version at a preset; that version becomes current. Returns jobId; poll studix_get_job for the MP4 URL.",
    input: RenderVersionInput,
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const out = await ctx.deps.studio.renderVersion(ctx.tenant, input);
      return {
        data: {
          projectId: out.projectId,
          versionId: out.versionId,
          version: out.version,
          jobId: out.job.id,
          status: out.job.status,
          replayed: out.replayed,
          ...(out.approval ? { approval: out.job.approval } : {}),
          reviewUrl: reviewUrl(ctx.deps, out.projectId),
        },
        next: out.next,
        scope: { projectId: out.projectId, jobId: out.job.id },
      };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.approve,
    title: "Decide approval",
    description:
      "Decide a pending approval. Only a signed-in person may decide: API keys (all MCP clients) get FORBIDDEN, so ask a workspace member to use the dashboard, then poll studix_get_job.",
    input: z.object({
      approvalId: Id,
      decision: z.enum(["approved", "rejected"]),
      comment: z.string().trim().max(2000).optional(),
    }),
    readOnly: false,
    audited: true,
    async run(ctx, input) {
      const approval = await ctx.deps.studio.approve(ctx.tenant, input);
      const next: NextAction[] =
        approval.subject.type === "job"
          ? [
              {
                tool: NATIVE_TOOL_NAMES.getJob,
                arguments: { jobId: approval.subject.id },
                reason: "Follow the job after the decision.",
              },
            ]
          : [];
      return {
        data: { approval },
        next,
        scope: approval.subject.type === "job" ? { jobId: approval.subject.id } : undefined,
      };
    },
  }),
] as const;

/** Narrow unknown tool output errors (e.g. thrown strings) for logging. */
export function describeError(error: unknown): string {
  if (error instanceof StudixError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
