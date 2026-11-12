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
import { createPublicWebFetcher } from "@studix/mcp-gateway";
import { type Clock, type Logger, systemClock } from "@studix/shared";
import { packPipelines, packRegistry } from "@studix/skills";
import {
  type CompositionRunner,
  createCompositionRunWorkflow,
  createJobExecutor,
  createMediaExecWorkflow,
  createVideoCreateWorkflow,
  createVideoPublishWorkflow,
  createWorkerJobQueue,
  createWorkerPool,
  type JobOutcome,
  type MediaExecRunner,
  type Planner,
  type QaGate,
  type SpeechProbe,
  type StageContext,
  type StageWebFetcher,
  type WorkerPool,
  type WorkerPoolStatus,
} from "@studix/workflow";

/** What `/readyz` reports about media: presence only, never a key value, path or provider message. */
export interface WorkerMediaStatus {
  executable: "configured" | "missing";
  state: "ready" | "missing_executable" | "check_failed";
  /** Stable failure code (`ENOENT`, `NOT_SET`, a StudixError code) when `state` is not `ready`. */
  code?: string;
  /** Whether this worker can open dashboard-stored keys (STUDIX_SECRETS_KEY is set). */
  secretsKey: boolean;
  /** Per vendor: a key is present. All false unless `state` is `ready`. */
  vendors: Record<string, boolean>;
}

/** What `/readyz` reports about the skill sandbox: backend and runner readiness, never an address or token. */
export interface WorkerSandboxStatus {
  backend: "docker" | "sidecar";
  /** Sidecar only: configured runners, how many answered /v1/info, and their image versions. */
  runners?: number;
  ready?: number;
  versions?: string[];
  /**
   * Sidecar only: the allowlisted workspaces, each as the first 16 hex chars of sha256(workspace id), so the app
   * can tell a workspace whether its tasks may use the runners without /readyz listing workspace ids. Absent when
   * the allowlist is `*`: every workspace may use them.
   */
  workspaceHashes?: string[];
  /** Why agent tasks with tools cannot run right now; absent when they can. Never an address or a runner error. */
  reason?: string;
}

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
   * Optional: reads public https resources for stages (a brand site and its logo). Defaults to the
   * SSRF-guarded fetcher of `@studix/mcp-gateway`.
   */
  web?: StageWebFetcher;
  /** Optional: safe media readiness (Multix executable and which vendor keys exist) reported by `/readyz`. */
  mediaStatus?(): Promise<WorkerMediaStatus>;
  /** Optional: skill sandbox readiness reported by `/readyz`; absent while the sandbox is off. */
  sandboxStatus?(): WorkerSandboxStatus;
  /**
   * Optional: the in-worker agent harness for an agent stage of a job. Without it agent stages run only in
   * host mode (the MCP client's agent completes them).
   */
  agentRuntimeFor?(stage: StageContext): AgentRuntime | undefined;
  /** Optional: the sandbox of `media.exec` jobs (studix_media_exec). Without it those jobs fail UNAVAILABLE. */
  mediaExec?: { runner: MediaExecRunner; centsPerMinute: number };
  /** Optional: the skill sandbox of `composition.run` jobs. Without it those jobs fail UNAVAILABLE. */
  compositionRun?: { runner: CompositionRunner; centsPerMinute: number };
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
      web: deps.web ?? createPublicWebFetcher(),
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
      createMediaExecWorkflow({
        ...(deps.mediaExec ? { runner: deps.mediaExec.runner } : {}),
        centsPerMinute: deps.mediaExec?.centsPerMinute ?? 0,
      }),
      createCompositionRunWorkflow({
        ...(deps.compositionRun ? { runner: deps.compositionRun.runner } : {}),
        centsPerMinute: deps.compositionRun?.centsPerMinute ?? 0,
      }),
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
