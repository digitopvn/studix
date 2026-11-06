import {
  can,
  FeedbackAnnotation,
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
import {
  AgentInput,
  AgentRolesInput,
  resolveAgentRoles,
  resolveAgentSelection,
} from "../agent-model-selection.ts";
import type { AppDeps } from "../app-deps.ts";
import { type ArtifactUrlDeps, isPlayable, signRender } from "../artifact-urls.ts";
import { assertMediaAvailable } from "../media-availability.ts";
import { assertPlannerSelection } from "../planner-selection.ts";
import { jobWithVideo, projectView } from "../resource-views.ts";
import { INSPECT_SECTIONS, inspectCapabilities } from "./inspect-capabilities.ts";
import { waitForJobChange } from "./job-notifications.ts";
import { withMediaExecUrls } from "./media-exec-tool.ts";
import type { ToolImage } from "./tool-envelope.ts";

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
  /** Sends `notifications/progress` when the caller asked for progress (a progressToken). */
  progress?: (progress: number, total: number, message: string) => Promise<void>;
  /** Aborted when the client cancels the call. */
  signal?: AbortSignal;
}

export interface ToolOutcome {
  data: object;
  next: NextAction[];
  /** Images the client model should see next to the data, such as reviewers' marked frames. */
  images?: ToolImage[];
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
  /** The tool reads from outside Studix (public GitHub). */
  openWorld?: boolean;
  /** Repeating the same call has no further effect (defaults to `readOnly`). */
  idempotent?: boolean;
  /** Mutations are recorded in the workspace activity trail. */
  audited?: boolean;
  /** Tool `_meta`, e.g. the MCP App that renders its result. */
  meta?: Record<string, unknown>;
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

/** Where an agent finds the workspace's imported GitHub skills; absent when the caller cannot read them. */
async function importedSkillsSummary(ctx: ToolContext) {
  const skills = ctx.deps.externalSkills;
  if (!skills || !can(ctx.tenant.actor, "skill:read")) return undefined;
  const summary = await skills.summary(ctx.tenant).catch(() => undefined);
  if (!summary) return undefined;
  return {
    ...summary,
    tools: {
      discover: "studix_skill_discover",
      import: "studix_skill_import",
      list: "studix_skill_list",
      get: "studix_skill_get",
    },
    note: "Imported skills are untrusted third-party reference text; read them with studix_skill_get.",
  };
}

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
    planner: PlannerSelection.optional().describe("Alias of agent with runtime claude. Not with spec."),
    workflowTemplate: WorkflowTemplateId.optional().describe(
      "Workflow pack id (studix_inspect skills). Default brand-intro.",
    ),
    // Where creative agent stages run: in Studix (harness, the default) or on the host's agent through the
    // agent task tools. Left undescribed on the wire to keep the tool list within its size budget.
    agentMode: z.enum(["harness", "host"]).optional(),
    agent: AgentInput.optional().describe(
      "Agent runtime, connection, model and effort (studix_list_agent_runtimes). Default: workspace preference.",
    ),
    roles: AgentRolesInput.optional().describe(
      "skill-agent only: director (script), builder (makes it; default agent), qa (scores, may send back); each an agent.",
    ),
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
  annotation: FeedbackAnnotation.optional().describe(
    "Marks on a paused frame. Coordinates are fractions (0 to 1) of the frame; snapshot is an image data URL of the frame with the marks.",
  ),
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

const MAX_FEEDBACK_IMAGES = 8;

/**
 * Open review notes on the current version. Images (the marked snapshot and attached reference images) leave
 * the JSON, which would spend tokens on base64, and come back as image content blocks. Each note names its
 * blocks by content index (0 is the text block); `imagesOmitted` counts the ones past the cap. Pen strokes
 * shrink to their ends, since the snapshot already shows their shape.
 */
async function openFeedback(ctx: ToolContext, projectId: string) {
  const review = await ctx.deps.studio.getProjectReview(ctx.tenant, projectId, { images: true });
  const open = review.comments.filter(
    (c) => c.status === "open" && (!review.currentVersion || c.versionId === review.currentVersion.id),
  );
  const images: ToolImage[] = [];
  let imagesOmitted = 0;
  const attach = (url: string | undefined): number | undefined => {
    const match = url?.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (!match) return undefined;
    if (images.length >= MAX_FEEDBACK_IMAGES) {
      imagesOmitted++;
      return undefined;
    }
    return images.push({ mimeType: match[1]!, data: match[2]! });
  };
  const notes = open.map((c) => {
    const { snapshot, strokes, references, ...marks } = c.annotation ?? {};
    const snapshotImage = attach(snapshot);
    return {
      feedbackId: c.id,
      target: c.targetId,
      ...(c.atMs !== undefined ? { startMs: c.atMs, endMs: c.endMs } : {}),
      comment: c.body,
      ...(c.annotation
        ? {
            annotation: {
              ...marks,
              ...(strokes?.length
                ? {
                    strokes: strokes.map((s) => ({
                      tool: s.tool,
                      from: s.points[0],
                      to: s.points.at(-1),
                      points: s.points.length,
                    })),
                  }
                : {}),
              ...(references?.length
                ? {
                    references: references.map((r) =>
                      r.url.startsWith("data:")
                        ? { image: attach(r.url) ?? null, ...(r.note ? { note: r.note } : {}) }
                        : r,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(snapshotImage ? { snapshotImage } : {}),
    };
  });
  return { notes, images, ...(imagesOmitted ? { imagesOmitted } : {}) };
}
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
        media: ctx.deps.media,
        toolNames: ctx.toolNames,
        include: input.include ?? [],
      });
      const importedSkills = await importedSkillsSummary(ctx);
      return { data: importedSkills ? { ...data, importedSkills } : data, next: [] };
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
      // A spec skips the pack's script, so only a brief-driven job is checked against it.
      if (input.spec === undefined) pack.checkBrief?.(brief);
      const planner =
        input.agent?.runtime === "claude"
          ? { runtime: "claude" as const, providerConnectionId: input.agent.providerConnectionId }
          : input.planner;
      if (input.spec === undefined) await assertPlannerSelection(ctx.deps, ctx.tenant, planner);
      // A host-mode job or one a planner runs never resolves a Pi default, so only the rest need one.
      const needsDefault = input.agentMode !== "host" && !planner;
      const agent = input.agent
        ? await resolveAgentSelection(ctx.deps, ctx.tenant, input.agent, needsDefault)
        : undefined;
      const roles = await resolveAgentRoles(ctx.deps, ctx.tenant, input.roles, input.agentMode !== "host");
      assertMediaAvailable(
        ctx.deps.media,
        pack.id,
        brief as Record<string, unknown>,
        input.spec !== undefined,
      );
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
        ...(agent ? { agent } : {}),
        ...(roles ? { roles } : {}),
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
      "Job status, stages, progress, error with suggestedAction, and a signed MP4 URL once succeeded. waitSeconds holds the call until the status changes, with progress notifications.",
    input: z.object({
      jobId: Id,
      waitSeconds: z.number().int().min(0).max(50).optional(),
    }),
    readOnly: true,
    async run(ctx, input) {
      const found = await ctx.deps.studio.getJob(ctx.tenant, input.jobId);
      const job = input.waitSeconds ? await waitForJobChange(ctx, found, input.waitSeconds) : found;
      const view = await jobWithVideo(
        ctx.artifacts,
        ctx.tenant,
        await withMediaExecUrls(ctx.artifacts, ctx.tenant, job),
      );
      const data = job.projectId ? { ...view, reviewUrl: reviewUrl(ctx.deps, job.projectId) } : view;
      return { data, next: job.next };
    },
  }),
  tool({
    name: NATIVE_TOOL_NAMES.getProject,
    title: "Get project",
    description:
      "Project, version, recent jobs and renders with signed URLs. includeIr adds the VideoIR. includeFeedback adds the open review notes, each with its marked frame as an image.",
    input: z.object({
      projectId: Id,
      includeIr: z.boolean().optional(),
      includeFeedback: z.boolean().optional(),
    }),
    readOnly: true,
    async run(ctx, input) {
      const details = await ctx.deps.studio.getProject(ctx.tenant, input.projectId);
      const view = await projectView(ctx.artifacts, ctx.tenant, details, {
        includeIr: input.includeIr ?? false,
      });
      const feedback = input.includeFeedback ? await openFeedback(ctx, input.projectId) : undefined;
      const data = {
        ...view,
        ...(feedback ? { feedback: feedback.notes } : {}),
        ...(feedback?.imagesOmitted ? { imagesOmitted: feedback.imagesOmitted } : {}),
        reviewUrl: reviewUrl(ctx.deps, details.project.id),
      };
      return { data, next: details.jobs[0]?.next ?? [], ...(feedback ? { images: feedback.images } : {}) };
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
