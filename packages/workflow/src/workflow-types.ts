import type { Approval, ApprovalAction, Job, TenantContext } from "@studix/core";
import type { CreativeBrief, VideoIR } from "@studix/video-ir";

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
  /** Approval that authorized this stage, when it is approval-gated. */
  approval?: Approval;
  /** Report progress inside the stage (0..1); persisted with throttling. */
  reportProgress(progress: number): void;
}

export interface StageDefinition {
  name: string;
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
  providerExecutionId?: string;
}

export interface PlannerContext {
  tenant: TenantContext;
  jobId: string;
  projectId: string;
  attempt: number;
  /** Remaining job budget in cents, when the job has one. */
  maxCostCents?: number;
}

/** Turns a creative brief into a VideoIR (backed by the DecisionRouter / brand-intro skill). */
export type Planner = (
  brief: CreativeBrief,
  ctx: PlannerContext,
  signal: AbortSignal,
) => Promise<{ ir: VideoIR; usage: PlanUsage[] }>;
