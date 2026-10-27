import { type NextAction, STUDIX_TOOLS, type TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { RenderPreset } from "@studix/video-ir";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import type { ArtifactUrlDeps } from "../artifact-urls.ts";
import { jobWithVideo, projectView } from "../resource-views.ts";
import { INSPECT_SECTIONS, inspectCapabilities } from "./inspect-capabilities.ts";

/** Native tool names. `studix_cancel_job` is not referenced by core next-hints, so it is named here. */
export const NATIVE_TOOL_NAMES = {
  ...STUDIX_TOOLS,
  cancelJob: "studix_cancel_job",
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
  /** Mutations are recorded in the workspace activity trail. */
  audited?: boolean;
  run(ctx: ToolContext, input: z.output<I>): Promise<ToolOutcome>;
}

function tool<I extends z.ZodType>(def: NativeTool<I>): NativeTool<I> {
  return def;
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
      .describe("Complete VideoIR authored by the host; skips internal planning."),
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
      .describe("Wall-clock limit for the job from now; past it the job fails with TIMEOUT."),
    renderPreset: RenderPreset.optional(),
  })
  .refine((v) => v.prompt !== undefined || v.brief !== undefined, {
    message: "Provide prompt or brief",
    path: ["prompt"],
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
      const result = await ctx.deps.studio.createVideoProject(ctx.tenant, {
        brief: brief as { prompt: string },
        spec: input.spec,
        title: input.title,
        idempotencyKey: input.idempotencyKey,
        budgetCents: input.budgetCents,
        ...(input.deadlineSeconds ? { deadlineAt: new Date(Date.now() + input.deadlineSeconds * 1000) } : {}),
        renderPreset: input.renderPreset,
      });
      return {
        data: {
          projectId: result.project.id,
          jobId: result.job.id,
          status: result.job.status,
          stage: result.job.stage ?? null,
          replayed: result.replayed,
          ...(result.approval ? { approval: result.job.approval } : {}),
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
      return { data: view, next: job.next };
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
      const data = await projectView(ctx.artifacts, ctx.tenant, details, {
        includeIr: input.includeIr ?? false,
      });
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
