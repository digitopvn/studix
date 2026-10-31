import type { ActorRef, Approval, ApprovalAction, Job, PlannerSelection, TenantContext } from "@studix/core";
import type { CreativeBrief, VideoIR } from "@studix/video-ir";
import type { z } from "zod";
import type { FencedRepositories } from "./worker-job-queue.ts";

/** JSON-safe stage output; stored as the stage checkpoint. */
export type StageOutput = Record<string, unknown>;

/** One usage line reported by a stage; the engine turns it into an idempotent ledger event. */
export interface StageUsage {
  /** Distinguishes several usage lines of one stage (e.g. "decision-0", "render"). */
  item: string;
  kind: string;
  quantity: number;
  unit: string;
  costCents: number;
  providerExecutionId?: string;
  metadata?: Record<string, unknown>;
}

export interface StageResult {
  output: StageOutput;
  usage?: StageUsage[];
}

export interface StageContext {
  ctx: TenantContext;
  job: Job;
  /** The job attempt this stage runs in (stage rows are keyed by it). */
  attempt: number;
  /** Aborted on cancel, deadline, lost lease or worker shutdown; `reason` is a StudixError. */
  signal: AbortSignal;
  /** Checkpointed outputs of the stages that already completed, by stage name. */
  outputs: Readonly<Record<string, StageOutput>>;
  /** The stage input parsed by `StageDefinition.inputSchema`; undefined for stages without one. */
  input: unknown;
  /** Approval that authorized this stage, when it is approval-gated. */
  approval?: Approval;
  /**
   * Run business writes (projects, renders) only while this worker still owns the job at this attempt.
   * `write` gets repositories bound to one transaction that is locked against reclaim; a stage that
   * outlived its attempt gets a `LeaseLostError` (or the abort reason) and nothing is written. Stages
   * must make business writes through this, never through repositories captured at wiring time.
   */
  commit<T>(write: (repos: FencedRepositories, ctx: TenantContext) => Promise<T>): Promise<T>;
  /** Report progress inside the stage (0..1); persisted with throttling. */
  reportProgress(progress: number): void;
}

/** What a stage's `inputSchema` parses: the job payload and the outputs of the stages before it. */
export interface StageInputSource {
  payload: Record<string, unknown>;
  outputs: Readonly<Record<string, StageOutput>>;
}

export interface StageDefinition {
  name: string;
  /**
   * Parses the stage input from a StageInputSource; the result is `stage.input`. A mismatch fails the
   * stage with a non-retryable VALIDATION error before anything runs or is charged.
   */
  inputSchema?: z.ZodType;
  /**
   * Shape of the stage output. Checked before a result is checkpointed or cached; a cached output that no
   * longer matches is ignored and the stage runs again.
   */
  outputSchema?: z.ZodType;
  /**
   * Ids of the knowledge packs (`@studix/skills`) this stage works from. The knowledge loader hands a stage
   * exactly these packs and nothing else; a stage without the field loads none.
   */
  knowledge?: readonly string[];
  /**
   * Identity of the work, normally `stageCacheKey(name, version, input)`: equal keys must produce
   * interchangeable outputs. When the runner has a stage cache holding the key for the tenant, the cached
   * output is reused and the stage is neither run, approval-gated, budget-checked nor charged again.
   * Return undefined to skip the cache for one run. Only stages with portable outputs (no worker-local
   * paths) may declare a key.
   */
  cacheKey?(stage: StageContext): string | undefined | Promise<string | undefined>;
  /**
   * Estimated cost in cents, checked against the job budget before the stage runs. Stages without an
   * estimate still get a budget check with a zero estimate (already-overspent jobs stop).
   */
  estimateCostCents?(stage: StageContext): number | Promise<number>;
  /** Gate the stage behind a human approval for this action (subject: the job). */
  approval?: { action: ApprovalAction; estimateCostCents?(job: Job): number | undefined };
  /**
   * "never": failures of this stage are not retried automatically (mutating downstream calls whose
   * outcome is unknown, e.g. publishing).
   */
  retry?: "default" | "never";
  /**
   * Whether a stored checkpoint can be reused (e.g. a local render file still exists). `saved` holds every
   * checkpoint of the job, including later stages.
   */
  isCheckpointValid?(
    output: StageOutput,
    saved: Readonly<Record<string, StageOutput>>,
  ): boolean | Promise<boolean>;
  run(stage: StageContext): Promise<StageResult>;
}

export interface WorkflowDefinition {
  kind: string;
  stages: readonly StageDefinition[];
  /** Job result built from the stage outputs once every stage succeeded. */
  result(outputs: Readonly<Record<string, StageOutput>>): Record<string, unknown>;
}

/** Cost of one model/provider call made while planning. */
export interface PlanUsage {
  provider: string;
  model?: string;
  costCents: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Wall time of the call, including fallbacks. */
  latencyMs?: number;
  /** Decision kind or capability the call served, e.g. "video.brief". */
  operation?: string;
  providerExecutionId?: string;
}

export interface PlannerContext {
  tenant: TenantContext;
  jobId: string;
  projectId: string;
  attempt: number;
  /** Remaining job budget in cents, when the job has one. */
  maxCostCents?: number;
  /** Who created the job; decides which provider credentials the planner may use. */
  requestedBy: ActorRef;
  /** Planner chosen for the job; omitted means the default planner. */
  planner?: PlannerSelection;
}

/** Turns a creative brief into a VideoIR (backed by the DecisionRouter / brand-intro skill). */
export type Planner = (
  brief: CreativeBrief,
  ctx: PlannerContext,
  signal: AbortSignal,
) => Promise<{ ir: VideoIR; usage: PlanUsage[] }>;
