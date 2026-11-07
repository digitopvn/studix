import { createJobBudgetPolicy, createUsageLedger } from "@studix/billing";
import {
  type AgentRuntime,
  type ApprovalPolicy,
  createDefaultApprovalPolicy,
  type MediaProvider,
  type PublisherAdapter,
  type RendererAdapter,
  type StorageAdapter,
  storyboardStatus,
  type TenantContext,
} from "@studix/core";
import { createRepositories, type StudixDb } from "@studix/database";
import { type Clock, type Logger, systemClock } from "@studix/shared";
import { packPipelines, packRegistry } from "@studix/skills";
import {
  createJobExecutor,
  createVideoCreateWorkflow,
  createVideoPublishWorkflow,
  createWorkerJobQueue,
  createWorkerPool,
  type JobOutcome,
  type Planner,
  type QaGate,
  type SpeechProbe,
  type StageContext,
  type WorkerPool,
  type WorkerPoolStatus,
} from "@studix/workflow";

/** Concrete adapters the worker runs stages with; supplied by the process entry (or tests). */
export interface WorkerPorts {
  planner: Planner;
  renderer: RendererAdapter;
  storage: StorageAdapter;
  /** Optional: without one, approved publish jobs fail with UNAVAILABLE. */
  publisher?: PublisherAdapter;
  /** Optional: paid media for pack stages (frames, clips, voice, music). Without it those stages fail UNAVAILABLE. */
  media?: MediaProvider;
  /** Optional: the media provider of one workspace's dashboard settings; falls back to `media`. */
  mediaFor?: (ctx: TenantContext) => Promise<MediaProvider | undefined>;
  /** Optional: the hard QA gate pack stages run on a render. Without it those stages fail UNAVAILABLE. */
  qa?: QaGate;
  /** Optional: detects a human voice in a generated sound effect. Without it effects are not checked. */
  speech?: SpeechProbe;
  /**
   * Optional: the in-worker agent harness for an agent stage of a job. Without it agent stages run only in
   * host mode (the MCP client's agent completes them).
   */
  agentRuntimeFor?(stage: StageContext): AgentRuntime | undefined;
  /** Release adapter resources (HTTP agents, clients) after the pool has drained. */
  close?(): Promise<void>;
}

export interface WorkerRuntimeSettings {
  workerId: string;
  concurrency: number;
  leaseMs: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  workDir: string;
  approvalCostThresholdCents: number;
  renderCentsPerSecond: number;
  /** Lifetime of approval requests the worker opens (default 7 days). */
  approvalTtlMs?: number;
}

export interface WorkerRuntimeDeps extends WorkerPorts {
  db: StudixDb;
  settings: WorkerRuntimeSettings;
  logger: Logger;
  clock?: Clock;
  approvalPolicy?: ApprovalPolicy;
  onOutcome?: (jobId: string, outcome: JobOutcome) => void;
}

export interface WorkerRuntime {
  start(): void;
  stop(graceMs: number): Promise<void>;
  status(): WorkerPoolStatus;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** Compose repositories, billing, workflows, executor and the claim-loop pool from injected ports. */
export function createWorkerRuntime(deps: WorkerRuntimeDeps): WorkerRuntime {
  const clock = deps.clock ?? systemClock;
  const { settings, logger } = deps;
  const repos = createRepositories(deps.db, { clock });
  const queue = createWorkerJobQueue(deps.db, { leaseMs: settings.leaseMs, clock });
  const executor = createJobExecutor({
    queue,
    jobs: repos.jobs,
    approvals: repos.approvals,
    approvalPolicy:
      deps.approvalPolicy ??
      createDefaultApprovalPolicy({ costThresholdCents: settings.approvalCostThresholdCents }),
    approvalTtlMs: settings.approvalTtlMs ?? WEEK_MS,
    billing: createJobBudgetPolicy(),
    ledger: createUsageLedger(repos.usage),
    stageCache: repos.stageCache,
    storyboardStatus: (ctx, projectId) => storyboardStatus(repos, ctx, projectId),
    agents: { handoffs: repos.agentHandoffs, runtimeFor: deps.agentRuntimeFor },
    ...(deps.mediaFor ? { mediaFor: deps.mediaFor } : {}),
    services: {
      media: deps.media,
      storage: deps.storage,
      renderer: deps.renderer,
      qa: deps.qa,
      ...(deps.speech ? { speech: deps.speech } : {}),
      workRoot: settings.workDir,
      executions: repos.usage,
    },
    clock,
    logger,
    heartbeatIntervalMs: settings.heartbeatIntervalMs,
    workflows: [
      createVideoCreateWorkflow({
        planner: deps.planner,
        renderer: deps.renderer,
        storage: deps.storage,
        projects: repos.projects,
        renders: repos.renders,
        workRoot: settings.workDir,
        renderCentsPerSecond: settings.renderCentsPerSecond,
        clock,
        // A project's workflowTemplate picks its pack pipeline; brand-intro and no template keep the default.
        pipelines: packPipelines(packRegistry),
      }),
      createVideoPublishWorkflow({ renders: repos.renders, publisher: deps.publisher }),
    ],
  });
  const pool: WorkerPool = createWorkerPool({
    queue,
    executor,
    workerId: settings.workerId,
    concurrency: settings.concurrency,
    pollIntervalMs: settings.pollIntervalMs,
    logger,
    onOutcome: deps.onOutcome,
  });
  return { start: () => pool.start(), stop: (graceMs) => pool.stop(graceMs), status: () => pool.status() };
}
