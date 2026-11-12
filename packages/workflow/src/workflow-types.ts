import type {
  ActorRef,
  AgentHandoff,
  AgentRuntime,
  Approval,
  ApprovalAction,
  FundingSource,
  Job,
  MediaJobJournal,
  MediaProvider,
  PlannerSelection,
  ProviderExecutionRecorder,
  RendererAdapter,
  StorageAdapter,
  TenantContext,
} from "@studix/core";
import type { AssetRef, CreativeBrief, VideoIR } from "@studix/video-ir";
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
  /** Who paid the provider for this line; `operator` when omitted (ADR 0016: BYOK spend is recorded, not charged). */
  funding?: FundingSource;
  /**
   * Upstream paid job this line bills (e.g. "sume:job_123"). Like a provider execution, it is billed once
   * per job whatever attempt reports it, so a stage that resumed a job it paid for never bills it twice.
   */
  upstreamJob?: string;
  metadata?: Record<string, unknown>;
}

export interface StageResult {
  output: StageOutput;
  usage?: StageUsage[];
}

/** What a QA hard gate checks a rendered file against. */
export interface QaExpectation {
  durationMs: number;
  fps: number;
  /** The file must carry an audio stream (and pass the loudness and sync checks). */
  requireAudio: boolean;
  /** Knowledge packs whose hard checks are bound in addition to the defaults. */
  knowledge?: readonly string[];
}

/** The blocking QA layer as a port, so pack stages can gate a render without depending on `@studix/qa`. */
export interface QaGate {
  /**
   * Measure `filePath` and resolve with the JSON report when every hard check passes. Throws a
   * non-retryable VALIDATION error when one fails; a file that could not be measured never passes.
   */
  assertPasses(
    filePath: string,
    expect: QaExpectation,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

/** How much of an audio file a speech probe heard as a human voice. */
export interface SpeechMeasurement {
  /** Total length of the voiced stretches, in milliseconds. */
  speechMs: number;
  /** Length of the audio, in milliseconds. */
  durationMs: number;
  /** True when the voiced stretches are long enough that the file counts as containing speech. */
  speech: boolean;
}

/**
 * Detects human speech in a generated audio file (voice activity detection). A stage that needs sound
 * with no voice in it (an effect the model may have read aloud) asks it before the file joins the mix.
 */
export interface SpeechProbe {
  /** Measure `filePath`. A file that could not be measured throws; it never counts as clean. */
  measure(filePath: string, signal: AbortSignal): Promise<SpeechMeasurement>;
}

/**
 * Ports a pack stage may use, wired once by the worker (`JobExecutorDeps.services`). Pack stages are
 * static, registry-friendly objects; whatever they need at run time comes from here. A stage that needs a
 * service the worker did not wire fails with a non-retryable UNAVAILABLE error (see `requireService`).
 */
export interface StageServices {
  media?: MediaProvider;
  storage?: StorageAdapter;
  renderer?: RendererAdapter;
  qa?: QaGate;
  /** Speech detector for generated sound effects; stages that need it skip the check when it is not wired. */
  speech?: SpeechProbe;
  /** Local scratch root; a stage writes under `<workRoot>/<jobId>/attempt-<n>/<stage>`. */
  workRoot?: string;
  /** Where media calls are recorded as `provider_executions` rows; calls go unrecorded when not wired. */
  executions?: ProviderExecutionRecorder;
  /**
   * SSRF-guarded GET of a public https URL: every redirect is re-checked, private and metadata addresses are
   * refused at connect time and the body is capped at `maxBytes`. `url` is the final URL after redirects.
   * Rejects with a StudixError when the URL is refused or cannot be fetched. Stages without it skip the fetch.
   */
  fetchPublic?: (
    url: string,
    options: { maxBytes: number },
    signal: AbortSignal,
  ) => Promise<{ body: Uint8Array; contentType: string; url: string }>;
}

/** A media output an earlier job of the tenant paid for and stored, found by the content key of its request. */
export interface ReusableMedia {
  asset: AssetRef;
  /** Job that generated (and paid for) the output. */
  jobId?: string;
}

/**
 * Tenant-wide store of paid media outputs keyed by what produced them (provider, kind, model, prompt,
 * parameters and the digests of the input files; never job, stage or asset ids). A stage asks it before it
 * pays for a request, so a change elsewhere in the IR does not buy the same output again.
 */
export interface MediaOutputCache {
  get(key: string): Promise<ReusableMedia | undefined>;
  /** First write wins: a key already stored keeps its asset. */
  put(key: string, asset: AssetRef): Promise<void>;
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
  /**
   * Decision that let this approval-gated stage run: an approval, or (creative gates) a change request the
   * stage acts on before it asks again.
   */
  approval?: Approval;
  /** Every request of this stage's gate (its action and scope) in this job, oldest first. */
  approvalHistory?: readonly Approval[];
  /**
   * Run business writes (projects, renders) only while this worker still owns the job at this attempt.
   * `write` gets repositories bound to one transaction that is locked against reclaim; a stage that
   * outlived its attempt gets a `LeaseLostError` (or the abort reason) and nothing is written. Stages
   * must make business writes through this, never through repositories captured at wiring time.
   */
  commit<T>(write: (repos: FencedRepositories, ctx: TenantContext) => Promise<T>): Promise<T>;
  /** Report progress inside the stage (0..1); persisted with throttling. */
  reportProgress(progress: number): void;
  /**
   * Durable journal of the upstream media jobs this stage submits; pass it as `journal` on every media
   * request. Each write is stored with the stage row (fenced like every stage write), and a later attempt
   * of the stage on any worker starts from the records of the earlier ones, so it collects a paid job by
   * id instead of submitting it again.
   */
  mediaJournal: MediaJobJournal;
  /** Paid media outputs of the tenant by content key; undefined when the worker was wired without a stage cache. */
  mediaOutputs?: MediaOutputCache;
  /** Ports wired by the worker; empty when it wired none. */
  services: StageServices;
  /** Services agent stages run on; undefined when the worker was wired without them. */
  agents?: AgentStageServices;
}

/** What an agent stage needs from the engine: the harness runtime and the state of its approvals and host task. */
export interface AgentStageServices {
  /** Runtime of the in-worker agent for this job; undefined when the worker runs no harness agent. */
  runtime?: AgentRuntime;
  /** The stage's latest host-agent task (any status, any attempt). */
  latestHandoff(): Promise<AgentHandoff | undefined>;
  /** The stage's latest overrun approval request. */
  latestOverrun(): Promise<Approval | undefined>;
  /** Overrun approvals a person granted this stage so far (approved or already consumed). */
  grantedOverruns(): Promise<number>;
  /** Spend an approved overrun request, fenced by job owner and attempt (throws LeaseLostError when lost). */
  consumeOverrun(approvalId: string): Promise<void>;
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
   * The output an agent hands in for this stage in host mode: the schema `studix_get_agent_task` advertises and
   * the MCP server checks a submission against. Set by `createAgentStage`; a stage that wraps an agent stage
   * under another output shape forwards the agent stage's.
   */
  hostOutputSchema?: z.ZodType;
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
   * paths) may declare a key. An output that carries a `warning` is a degraded result (e.g. a skipped
   * optional step): it is neither cached nor reused, so the next run tries the full work again.
   */
  cacheKey?(stage: StageContext): string | undefined | Promise<string | undefined>;
  /**
   * Estimated cost in cents, checked against the job budget before the stage runs. Stages without an
   * estimate still get a budget check with a zero estimate (already-overspent jobs stop).
   */
  estimateCostCents?(stage: StageContext): number | Promise<number>;
  /**
   * Gate the stage behind a human approval for this action (subject: the job). `scopeKey` separates gates of
   * one action in a job (creative gates use `gate:<id>`); `reason` tells the reviewer what to sign off.
   */
  approval?: {
    action: ApprovalAction;
    estimateCostCents?(job: Job): number | undefined;
    scopeKey?: string;
    reason?: string;
  };
  /**
   * Run only when a person approved the project's storyboard (image-to-video and other per-shot generation
   * that spends on the plan). Checked before the stage cache; otherwise the job fails with a non-retryable
   * APPROVAL_REQUIRED and nothing is run or charged.
   */
  requiresApprovedStoryboard?: boolean;
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

/** The stages one job runs, and the result built from their outputs. */
export interface WorkflowRoute {
  stages: readonly StageDefinition[];
  result(outputs: Readonly<Record<string, StageOutput>>): Record<string, unknown>;
}

export interface WorkflowDefinition {
  kind: string;
  stages: readonly StageDefinition[];
  /** Job result built from the stage outputs once every stage succeeded. */
  result(outputs: Readonly<Record<string, StageOutput>>): Record<string, unknown>;
  /**
   * Stages for one job when they depend on it (e.g. the workflow pack its project uses); undefined runs
   * `stages`. A throw fails the job before any stage runs.
   */
  route?(job: Job): WorkflowRoute | undefined;
}

/** The video.create engine stages a pack pipeline is assembled from. */
export interface EngineStages {
  /** Loads the project brief: output `{ brief }`. */
  brief: StageDefinition;
  /** Plans a new IR with the planner, or loads the job's version: output `{ ir, versionId? }`. */
  plan: StageDefinition;
  /** Stores the latest IR of the job as a project version: output `{ versionId }`. */
  validateIr: StageDefinition;
  /** Renders the latest IR of the job with the worker's renderer. */
  render: StageDefinition;
  upload: StageDefinition;
  /** Records the render and moves the project to review. */
  finalize: StageDefinition;
  /**
   * Ends a job at the storyboard: the project waits for review and nothing is rendered. Output
   * `{ projectVersionId }`.
   */
  storyboardReady: StageDefinition;
}

/** Which video.create job a pack pipeline is asked to plan. */
export interface PackJob {
  /**
   * The job renders a stored version (studix_render, a feedback patch) rather than starting from the
   * brief of a new project.
   */
  fromVersion: boolean;
  /** The version came from reviewer feedback (a patch); the job applies it and goes back to review. */
  feedback?: boolean;
  /** Redraw the storyboard shots a reviewer asked to change (payload `storyboardRedraw`), then stop. */
  redraw?: boolean;
  /** The raw job payload, for pipelines that vary by job options (for example skill-agent roles). */
  payload?: unknown;
}

/**
 * How a workflow pack runs a video.create job: its own stages (typed, cached, knowledge-scoped) woven
 * between the engine's. Packs without a pipeline run the engine's default plan -> render chain.
 */
export interface PackPipeline {
  /** Renderer id the pack's IR is written for; a worker with another renderer fails the job up front. */
  renderer?: string;
  stages(job: PackJob, engine: EngineStages): readonly StageDefinition[];
  /** Job result; defaults to the finalize (or storyboard_ready) output. */
  result?(outputs: Readonly<Record<string, StageOutput>>): Record<string, unknown>;
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
  /** Who paid the provider for the call; `operator` when omitted. */
  funding?: FundingSource;
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
  /** Workflow pack id from the pack registry; omitted for jobs created before packs were selectable. */
  workflowTemplate?: string;
}

/** Turns a creative brief into a VideoIR (backed by the DecisionRouter / brand-intro skill). */
export type Planner = (
  brief: CreativeBrief,
  ctx: PlannerContext,
  signal: AbortSignal,
) => Promise<{ ir: VideoIR; usage: PlanUsage[] }>;
