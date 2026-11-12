import type { Clock, Logger, StudixErrorPayload } from "@studix/shared";
import {
  CreativeBrief,
  IrId,
  Milliseconds,
  PositiveMilliseconds,
  RenderPreset,
  VideoIRPatch,
} from "@studix/video-ir";
import { z } from "zod";
import type { Job, JobStatus, StageStatus } from "../entities/job.ts";
import type { JobAgentView } from "../entities/job-agent.ts";
import { AGENT_RUNTIMES, REASONING_EFFORTS } from "../entities/model-preference.ts";
import type { Approval, ApprovalAction, ApprovalStatus, ApprovalSubjectType } from "../entities/review.ts";
import type { ApprovalPolicy } from "../ports/approval-policy.ts";
import type { JobQueue } from "../ports/job-queue.ts";
import type { ProviderJobInspector } from "../ports/media-provider.ts";
import type { AssetRepository } from "../repositories/asset-repository.ts";
import type {
  ApprovalRepository,
  AuditRepository,
  ReviewRepository,
} from "../repositories/governance-repositories.ts";
import type { JobRepository, RenderRepository } from "../repositories/job-repository.ts";
import type { ProjectRepository } from "../repositories/project-repository.ts";
import type { RevisionRepository } from "../repositories/revision-repositories.ts";
import type { StoryboardRepository } from "../repositories/storyboard-repository.ts";
import type { UsageRepository } from "../repositories/telemetry-repositories.ts";
import type { TenantContext } from "../tenant.ts";
import type { StageRunView } from "./stage-run.ts";

/** MCP tool names that next-action hints point to (the MCP server registers tools with these names). */
export const STUDIX_TOOLS = {
  inspect: "studix_inspect",
  createVideo: "studix_create_video",
  getJob: "studix_get_job",
  retryJob: "studix_retry_job",
  getProject: "studix_get_project",
  approve: "studix_approve",
  feedback: "studix_feedback",
  render: "studix_render",
  listAssets: "studix_list_assets",
} as const;

/** A suggested follow-up call, so clients never have to guess the workflow. */
export interface NextAction {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  /** For polling hints: wait at least this long before calling. */
  pollAfterMs?: number;
}

export interface StudioDefaults {
  jobBudgetCents: number;
  jobDeadlineMs: number;
  jobMaxAttempts: number;
  /** How long a pending approval stays valid. */
  approvalTtlMs: number;
}

export interface StudioServiceDeps {
  projects: ProjectRepository;
  jobs: JobRepository;
  renders: RenderRepository;
  assets: AssetRepository;
  approvals: ApprovalRepository;
  audit: AuditRepository;
  reviews: ReviewRepository;
  revisions: RevisionRepository;
  storyboards: StoryboardRepository;
  queue: JobQueue;
  /** Usage lines and connection labels for each stage's runtime and cost; job views omit them when absent. */
  usage?: Pick<UsageRepository, "list">;
  providerConnections?: { get(ctx: TenantContext, id: string): Promise<{ label: string } | undefined> };
  /** Checks an upstream job before `attachMediaJob` records it; without one, attaching is refused. */
  providerJobs?: ProviderJobInspector;
  approvalPolicy: ApprovalPolicy;
  clock: Clock;
  logger?: Logger;
  defaults?: Partial<StudioDefaults>;
}

/** Workflow pack id from the pack registry; the MCP server and dashboard check it against the registry. */
export const WorkflowTemplateId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "a workflow pack id is lowercase kebab-case");

/** Pack used when a request names none. */
export const DEFAULT_WORKFLOW_TEMPLATE = "brand-intro";

const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,200}$/, "1-200 chars of letters, digits, '.', '_', ':' or '-'");

/**
 * Opt-in planner choice. Omitted means the default planner. `claude` plans with the Claude Agent SDK
 * using one Anthropic provider connection; the worker never falls back to another planner or key.
 */
export const PlannerSelection = z
  .object({
    runtime: z.literal("claude"),
    providerConnectionId: z.string().min(1).max(100),
  })
  .strict();
export type PlannerSelection = z.infer<typeof PlannerSelection>;

/**
 * The agent a job's creative stages run on, already checked by the caller: the runtime, the provider
 * connection that pays, and optionally the model and its reasoning effort. Stored on the job payload, so
 * every attempt runs the same agent. `claude` is the same path as `planner`.
 */
export const JobAgentSelection = z
  .object({
    runtime: z.enum(AGENT_RUNTIMES),
    connectionId: z.string().min(1).max(100),
    provider: z.string().min(1).max(60),
    modelId: z.string().min(1).max(200).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();
export type JobAgentSelection = z.infer<typeof JobAgentSelection>;

/**
 * Optional role agents of a job, each on its own runtime, model and effort. In an agent-authored job
 * (`skill-agent`) the director writes the script and direction, the builder makes the video, QA scores it
 * against a rubric and may send it back to the builder; a role left out runs on `agent` (builder) or is skipped
 * (director, qa). In `motion-graphic` a director turns on the premium tier: it writes the storyboard and may
 * author hero cards in custom HTML.
 */
export const AGENT_ROLES = ["director", "builder", "qa"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const JobAgentRoles = z
  .object({
    director: JobAgentSelection.optional(),
    builder: JobAgentSelection.optional(),
    qa: JobAgentSelection.optional(),
  })
  .strict();
export type JobAgentRoles = z.infer<typeof JobAgentRoles>;

/** The agent stage names each role runs, across the packs that have role agents. */
export const ROLE_STAGES: Readonly<Record<AgentRole, readonly string[]>> = {
  director: ["skill-agent.director", "motion-graphic.storyboard"],
  builder: ["skill-agent.run"],
  qa: ["skill-agent.qa"],
};

/** The agent one stage runs on: its role's agent when the job names one, else the job's `agent`. */
export function stageAgentSelection(payload: unknown, stage: string): JobAgentSelection | undefined {
  const p = (payload ?? {}) as { agent?: unknown; roles?: unknown };
  const role = AGENT_ROLES.find((r) => ROLE_STAGES[r].includes(stage));
  const roles = JobAgentRoles.safeParse(p.roles ?? {});
  const own = role && roles.success ? roles.data[role] : undefined;
  if (own) return own;
  const agent = JobAgentSelection.safeParse(p.agent);
  return agent.success ? agent.data : undefined;
}

/**
 * Where a job's creative agent stages run: `harness` (default) inside the worker under hard caps, `host` on the
 * MCP client's own agent through the handoff tools (no model spend for Studix).
 */
export const AgentMode = z.enum(["harness", "host"]);
export type AgentMode = z.infer<typeof AgentMode>;

/** Boundary schema for createVideoProject; `spec` is checked separately with validateVideoIR. */
export const CreateVideoProjectInput = z.object({
  brief: CreativeBrief,
  spec: z.unknown().optional(),
  planner: PlannerSelection.optional(),
  workflowTemplate: WorkflowTemplateId.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: IdempotencyKey.optional(),
  budgetCents: z.number().int().min(0).max(10_000_000).optional(),
  deadlineAt: z.coerce.date().optional(),
  renderPreset: RenderPreset.optional(),
  agentMode: AgentMode.optional(),
  agent: JobAgentSelection.optional(),
  roles: JobAgentRoles.optional(),
});
export type CreateVideoProjectInput = z.input<typeof CreateVideoProjectInput>;

const Id = z.string().min(1).max(100);
const BudgetCents = z.number().int().min(0).max(10_000_000);

/** Options of a job that renders a stored version (render, and feedback with a patch). */
const VersionJobOptions = {
  renderPreset: RenderPreset.optional(),
  idempotencyKey: IdempotencyKey.optional(),
  budgetCents: BudgetCents.optional(),
};

/**
 * Feedback on one target of the current version: a shot, a scene, an asset, a film character's voice
 * (`characterId`), or a time range of the video (`startMs` with `endMs`). `patch` ops are JSON pointers into the VideoIR and must stay inside the
 * target (feedback without a patch answers with the `allowedPaths`); with a patch a new version is stored
 * and a render job is queued.
 */
const Fraction = z.number().min(0).max(1);
const FramePoint = z.object({ x: Fraction, y: Fraction });
const ImageDataUrl = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "an image data URL");

/** Marks on a paused frame: where and what to change, shown to the agent as text and as a snapshot image. */
export const FeedbackAnnotation = z
  .object({
    intent: z.enum(["change", "fix", "remove", "add", "keep"]).optional(),
    priority: z.enum(["must", "should", "nice"]).optional(),
    frameMs: Milliseconds.optional(),
    region: FramePoint.extend({ w: Fraction, h: Fraction }).optional(),
    pins: z
      .array(FramePoint.extend({ label: z.string().trim().max(60).optional() }))
      .max(20)
      .optional(),
    strokes: z
      .array(z.object({ tool: z.enum(["pen", "arrow"]), points: z.array(FramePoint).min(2).max(120) }))
      .max(30)
      .optional(),
    snapshot: ImageDataUrl.max(100_000).optional(),
    references: z
      .array(
        z.object({
          url: z.union([z.url({ protocol: /^https?$/ }).max(2000), ImageDataUrl.max(30_000)]),
          note: z.string().trim().max(300).optional(),
        }),
      )
      .max(6)
      .optional(),
  })
  .strict()
  // The parts fit one by one but not all together: the whole note stays under the API's 256 KB request limit.
  .refine((a) => JSON.stringify(a).length <= 200_000, {
    message: "Annotation is over 200 KB; attach fewer or smaller reference images.",
  });
export type FeedbackAnnotation = z.infer<typeof FeedbackAnnotation>;

export const FeedbackInput = z
  .object({
    projectId: Id,
    shotId: IrId.optional(),
    sceneId: IrId.optional(),
    assetId: IrId.optional(),
    /** A film character: a patch may only change that character's voice in the production bible. */
    characterId: IrId.optional(),
    startMs: Milliseconds.optional(),
    endMs: PositiveMilliseconds.optional(),
    comment: z.string().trim().min(1).max(2000),
    annotation: FeedbackAnnotation.optional(),
    patch: VideoIRPatch.optional(),
    /** The version the feedback was written against; CONFLICT when the project moved on. */
    baseVersionId: Id.optional(),
    ...VersionJobOptions,
  })
  .refine(
    (v) =>
      [v.shotId, v.sceneId, v.assetId, v.characterId, v.startMs ?? v.endMs].filter((t) => t !== undefined)
        .length === 1 && (v.startMs === undefined) === (v.endMs === undefined),
    {
      message: "Give exactly one target: shotId, sceneId, assetId, characterId, or startMs with endMs",
      path: ["shotId"],
    },
  )
  .refine((v) => v.startMs === undefined || v.endMs === undefined || v.endMs > v.startMs, {
    message: "endMs must be after startMs",
    path: ["endMs"],
  });
export type FeedbackInput = z.input<typeof FeedbackInput>;

/** Render a stored version (the current one by default); the rendered version becomes current. */
export const RenderVersionInput = z.object({ projectId: Id, versionId: Id.optional(), ...VersionJobOptions });
export type RenderVersionInput = z.input<typeof RenderVersionInput>;

/** A reviewer's decision on the storyboard, one scene or one shot. */
export const StoryboardDecisionInput = z
  .object({
    projectId: Id,
    target: z.enum(["storyboard", "scene", "shot"]),
    targetId: IrId.optional(),
    decision: z.enum(["approved", "changes_requested"]),
    note: z.string().trim().min(1).max(1000).optional(),
    /** Storyboard revision the reviewer saw (0 before the first decision); CONFLICT when it moved on. */
    expectedRevision: z.number().int().min(0).optional(),
  })
  .refine((v) => (v.target === "storyboard") === (v.targetId === undefined), {
    message: "targetId is required for a scene or shot and not allowed for the storyboard",
    path: ["targetId"],
  });
export type StoryboardDecisionInput = z.input<typeof StoryboardDecisionInput>;

export const RequestApprovalInput = z.object({
  action: z.enum(["job.start", "render.final", "publish", "provider.spend", "connector.execute", "delete"]),
  subjectType: z.enum(["project", "project_version", "job", "render", "asset"]),
  subjectId: z.string().min(1).max(100),
  reason: z.string().trim().min(1).max(1000).optional(),
  estimatedCostCents: z.number().int().min(0).optional(),
});
export type RequestApprovalInput = z.input<typeof RequestApprovalInput>;

/** `changes_requested` (creative gates only) names the assets to redo in `targets`; `comment` is the note. */
export const DecideApprovalInput = z
  .object({
    approvalId: z.string().min(1).max(100),
    decision: z.enum(["approved", "rejected", "changes_requested"]),
    comment: z.string().trim().max(2000).optional(),
    targets: z.array(IrId).min(1).max(20).optional(),
  })
  .refine((v) => (v.decision === "changes_requested") === (v.targets !== undefined), {
    message: "targets are required with changes_requested and not allowed otherwise",
    path: ["targets"],
  })
  .refine((v) => v.decision !== "changes_requested" || (v.comment ?? "").length > 0, {
    message: "a change request needs a comment saying what to change",
    path: ["comment"],
  });
export type DecideApprovalInput = z.input<typeof DecideApprovalInput>;

/**
 * An Atlas prediction an operator found for a media call stuck at "submitting". Only Atlas calls journal
 * that intent (Sume deduplicates by idempotency key), so the provider is implied.
 */
export const AttachMediaJobRequest = z.object({
  jobId: Id,
  stage: z.string().trim().min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(500),
  predictionId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "an Atlas Cloud prediction id"),
});
export type AttachMediaJobRequest = z.input<typeof AttachMediaJobRequest>;

export const RecordAuditInput = z.object({
  action: z.string().regex(/^[a-z][a-z0-9_.-]{1,99}$/, "dotted lowercase action name"),
  subjectType: z.string().min(1).max(60),
  subjectId: z.string().min(1).max(100).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type RecordAuditInput = z.input<typeof RecordAuditInput>;

export interface StageReviewView {
  rounds: {
    scores: Record<string, number>;
    overall: number;
    verdict: "pass" | "revise";
    notes: string;
  }[];
}

export interface StageView {
  name: string;
  status: StageStatus;
  attempt: number;
  startedAt?: Date;
  finishedAt?: Date;
  error?: StudixErrorPayload;
  /** Set when the stage finished on a fallback instead of its agent, with the reason. Never silent. */
  fallback?: string;
  /** Set when the stage succeeded but skipped an optional part (e.g. a decorative sound effect), with why. */
  warning?: string;
  /** QA rounds when the job has a `qa` role: scores 0-10, verdict and notes per round. */
  review?: StageReviewView;
  /** What the attempt ran on and spent; absent while a stage runs and has booked nothing yet. */
  run?: StageRunView;
}

export interface ApprovalView {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  reason: string;
  subjectType: ApprovalSubjectType;
  subjectId: string;
  expiresAt?: Date;
}

/** Client-facing job state: progress, structured error and what to do next. */
export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  projectId?: string;
  stage?: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  budget: { limitCents?: number; spentCents: number };
  deadlineAt?: Date;
  /** Budget left while the deadline is paused at a gate or host task; `deadlineAt` is unset then. */
  deadlineRemainingMs?: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  result?: Record<string, unknown>;
  error?: StudixErrorPayload;
  stages: StageView[];
  approval?: ApprovalView;
  /** Runtime, model and effort the job's creative stages run on (see `jobAgent`). */
  agent: JobAgentView;
  /** Why a `queued` job has not started: its place in line, or when its retry is due. */
  queue?: JobQueueView;
  next: NextAction[];
}

export interface JobQueueView {
  /** 1 is next to run; absent while the job waits for a scheduled retry. */
  position?: number;
  /** Jobs holding a worker slot now (all workspaces). */
  running: number;
  /** Plain-language wait reason for a caller. */
  reason: string;
}

export type { Approval, Job };
