import {
  type AgentSpend,
  agentSpendOf,
  CLAUDE_AGENT_RUNTIME_ID,
  CLAUDE_CODE_SANDBOX_RUNTIME_ID,
  type ClaudeAgentTransport,
  CODEX_AGENT_RUNTIME_ID,
  createClaudeAgentRuntime,
  createClaudeCodeSandboxRuntime,
  createCodexAgentRuntime,
  createPiSdkAgentRuntime,
  createProviderBindingResolver,
  type PiCredentialSource,
  type PiResolvedRun,
  type PiTaskWorkspaceProvider,
} from "@studix/agent-runtime";
import { claudeCredentialKind as credentialKind, type ProviderConnectionService } from "@studix/auth";
import {
  type ActivityRepository,
  type AgentRunResult,
  type AgentRunRoute,
  type AgentRuntime,
  type AgentRuntimeName,
  type AgentTask,
  connectionFunding,
  FUNDING_SOURCES,
  type FundingSource,
  JobAgentSelection,
  type ModelChoice,
  type ModelSelectionSource,
  PlannerSelection,
  type ProviderExecutionStatus,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type ResolvedModelSnapshot,
  resolveModelSelection,
  sameModelRoute,
  stageAgentSelection,
  type TenantContext,
  type UsageRepository,
} from "@studix/core";
import type { ModelPreferenceRepository, ModelSnapshotRepository } from "@studix/database";
import { type Clock, type Logger, StudixError, systemClock, toStudixError } from "@studix/shared";
import type { StageContext } from "@studix/workflow";
import { z } from "zod";
import { type AgentEventSink, createAgentEventSink } from "./agent-event-sink.ts";

/** Provider ids recorded on the provider executions of harness runs (same as the planner and decisions). */
export const HARNESS_PROVIDER: Readonly<Record<AgentRuntimeName, string>> = {
  claude: "anthropic",
  codex: "openai",
  pi: "pi",
};

export interface WorkerAgentHarnessDeps {
  /** Opens the selected connection's key for one run; never substitutes another connection. */
  credentials: Pick<ProviderConnectionService, "resolveForExecution">;
  preferences: Pick<ModelPreferenceRepository, "list">;
  snapshots: ModelSnapshotRepository;
  /** Stores each run's live events with its job for the dashboard chat; omitted, nothing is streamed. */
  events?: Pick<ActivityRepository, "append">;
  /** Records one provider execution per run, succeeded or not. */
  executions: Pick<UsageRepository, "recordProviderExecution">;
  /** The worker's Claude runtime (STUDIX_CLAUDE_PLANNER). Without it a stage that resolves to Claude fails. */
  claude?: {
    transport: ClaudeAgentTransport;
    /** Model of jobs that selected the Claude planner; a model preference brings its own model. */
    plannerModel: string;
    /** Test seam; production runs the Claude Code binary in the skill sandbox for tool-using tasks. */
    sandboxRuntimeFor?: typeof createClaudeCodeSandboxRuntime;
  };
  logger: Logger;
  clock?: Clock;
  /** The worker's Codex runtime; it runs in the skill sandbox, so it also needs `piWorkspace`. */
  codex?: {
    /** Model of a Codex job that named none. */
    defaultModel: string;
    /** Test seam; production runs the Codex CLI in the sandbox. */
    runtimeFor?: typeof createCodexAgentRuntime;
  };
  /** Test seam; production runs the real Pi SDK. */
  piRuntimeFor?: (resolved: PiResolvedRun, workspace?: PiTaskWorkspaceProvider) => AgentRuntime;
  /** The skill sandbox of a stage's tool-using Pi runs (STUDIX_SANDBOX); without it such runs fail VALIDATION. */
  piWorkspace?: (stage: StageContext) => PiTaskWorkspaceProvider;
  /**
   * Stores one file a run left in /work/out so the dashboard can preview it and a later task can take it as
   * an input file; resolves undefined for files it skips. Omitted, artifact events carry only the name.
   */
  storeArtifact?: (
    ctx: TenantContext,
    stage: StageContext,
    hostPath: string,
  ) => Promise<{ assetId: string; storageKey: string; url: string; contentType: string } | undefined>;
  /** Host paths of the media a stage run left outside /work/out, stored as preview artifacts. */
  previewFiles?: (stage: StageContext) => Promise<string[]>;
}

export interface WorkerAgentHarness {
  /** The in-worker runtime of one agent stage run (`WorkerPorts.agentRuntimeFor`). */
  runtimeFor(stage: StageContext): AgentRuntime;
  /** Resolves true once every run has settled (its agent process exited), false if `timeoutMs` passed first. */
  idle(timeoutMs: number): Promise<boolean>;
}

/** `source` marks a Claude choice taken from a preference, pinned once its connection is opened. */
type Choice =
  | {
      runtime: "claude";
      connectionId: string;
      model: string;
      source?: ModelSelectionSource;
      reasoningEffort?: ReasoningEffort;
    }
  | { runtime: "codex"; connectionId: string; model: string; reasoningEffort?: ReasoningEffort }
  | { runtime: "pi"; resolved: PiResolvedRun };

/** Most specific first, as in `resolveModelSelection`. */
const SOURCE_RANK: Readonly<Record<ModelSelectionSource, number>> = {
  "user-stage": 0,
  "workspace-stage": 1,
  "user-default": 2,
  "workspace-default": 3,
};

const EXECUTION_STATUS: Partial<Record<string, ProviderExecutionStatus>> = {
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
};

function noAgentModel(stage: string): StudixError {
  return new StudixError("UNAVAILABLE", `No model is configured for agent stage "${stage}"`, {
    retryable: false,
    suggestedAction:
      "Connect a provider and choose a default model in Settings → AI & Providers, or submit the job with payload.agentMode 'host'.",
  });
}

function claudeOff(stage: string): StudixError {
  return new StudixError(
    "UNAVAILABLE",
    `Agent stage "${stage}" resolved to Claude, which this worker does not run`,
    {
      retryable: false,
      suggestedAction:
        "Choose a Pi model in Settings → AI & Providers, or ask the operator to enable STUDIX_CLAUDE_PLANNER.",
    },
  );
}

function codexOff(stage: string): StudixError {
  return new StudixError(
    "UNAVAILABLE",
    `Agent stage "${stage}" selected Codex, which this worker does not run`,
    {
      retryable: false,
      suggestedAction: "Ask the operator to enable STUDIX_SANDBOX (Codex runs in the skill sandbox).",
    },
  );
}

/**
 * Runs harness-mode agent stages inside the worker, on the job's own provider connection (ADR 0016). The
 * runtime is chosen per job and stage: a job that selected the Claude planner runs its agent stages on that
 * Anthropic connection; otherwise the stage's pinned snapshot, otherwise the most specific model preference
 * of either runtime (Pi on a tie). Nothing is chosen means the stage fails UNAVAILABLE; no operator key is
 * ever substituted. The bounded runtimes enforce the stage caps (ADR 0015). Every run is recorded as a
 * provider execution, and its id rides on the result (or on the error's spend) so the stage bills the
 * run's real tokens and cost against it.
 */
export function createWorkerAgentHarness(deps: WorkerAgentHarnessDeps): WorkerAgentHarness {
  const clock = deps.clock ?? systemClock;
  const log = deps.logger.child({ component: "agent-harness" });
  const piRuntimeFor =
    deps.piRuntimeFor ??
    ((resolved: PiResolvedRun, workspace?: PiTaskWorkspaceProvider) =>
      createPiSdkAgentRuntime({
        resolver: { resolve: async () => resolved },
        ...(workspace ? { workspace } : {}),
      }));
  const inFlight = new Set<Promise<unknown>>();

  async function pin(ctx: TenantContext, jobId: string, snapshot: ResolvedModelSnapshot) {
    const stored = await deps.snapshots.pin(ctx, jobId, snapshot);
    return sameModelRoute(stored, snapshot) ? undefined : stored;
  }

  async function resolvePi(
    stage: StageContext,
    name: string,
    snapshot?: ResolvedModelSnapshot,
  ): Promise<Choice> {
    const resolved = await createProviderBindingResolver({
      credentials: deps.credentials as PiCredentialSource,
      preferences: deps.preferences,
      requestedBy: stage.job.createdBy,
      ...(snapshot ? { snapshot } : {}),
      ...jobModelRequest(stage.job.payload, name),
    }).resolve(stage.ctx, { stage: name });
    if (snapshot || !resolved.snapshot) return { runtime: "pi", resolved };
    // A concurrent attempt pinned first: run what it stored so every attempt of the job uses one route.
    const stored = await pin(stage.ctx, stage.job.id, resolved.snapshot);
    return stored ? resolvePi(stage, name, stored) : { runtime: "pi", resolved };
  }

  async function choose(stage: StageContext, name: string): Promise<Choice> {
    const { ctx, job } = stage;
    // A role agent (director, builder, qa) wins over the job's agent for its own stage.
    const selected = stageAgentSelection(job.payload, name);
    const ownRole = selected !== undefined && !sameSelection(selected, job.payload.agent);
    const agent = selected ? { success: true as const, data: selected } : { success: false as const };
    if (agent.success && agent.data.runtime === "codex") {
      if (!deps.codex || !deps.piWorkspace) throw codexOff(name);
      return {
        runtime: "codex",
        connectionId: agent.data.connectionId,
        model: agent.data.modelId ?? deps.codex.defaultModel,
        ...(agent.data.reasoningEffort ? { reasoningEffort: agent.data.reasoningEffort } : {}),
      };
    }
    if (agent.success && ownRole && agent.data.runtime === "claude") {
      if (!deps.claude) throw claudeOff(name);
      return {
        runtime: "claude",
        connectionId: agent.data.connectionId,
        model: agent.data.modelId ?? deps.claude.plannerModel,
        ...(agent.data.reasoningEffort ? { reasoningEffort: agent.data.reasoningEffort } : {}),
      };
    }
    if (agent.success && ownRole && agent.data.runtime === "pi") return resolvePi(stage, name);
    const planner = PlannerSelection.safeParse(job.payload.planner);
    if (planner.success) {
      if (!deps.claude) throw claudeOff(name);
      return {
        runtime: "claude",
        connectionId: planner.data.providerConnectionId,
        // `agent.modelId` is the per-job model of a Claude agent; the planner alias has none.
        model:
          (agent.success && agent.data.runtime === "claude" && agent.data.modelId) ||
          deps.claude.plannerModel,
        ...(agent.success && agent.data.runtime === "claude" && agent.data.reasoningEffort
          ? { reasoningEffort: agent.data.reasoningEffort }
          : {}),
      };
    }
    const [pinnedPi, pinnedClaude] = await Promise.all([
      deps.snapshots.get(ctx, job.id, { runtime: "pi", stage: name }),
      deps.snapshots.get(ctx, job.id, { runtime: "claude", stage: name }),
    ]);
    if (pinnedPi) return resolvePi(stage, name, pinnedPi);
    if (pinnedClaude) {
      return { runtime: "claude", connectionId: pinnedClaude.connectionId, model: pinnedClaude.modelId };
    }

    const userId = job.createdBy.type === "user" ? job.createdBy.id : undefined;
    const preferences = await deps.preferences.list(ctx, userId ? { userId } : {});
    const query = { stage: name, ...(userId ? { userId } : {}) };
    const pi = resolveModelSelection(preferences, { ...query, runtime: "pi" });
    const claude = resolveModelSelection(preferences, { ...query, runtime: "claude" });
    if (pi && (!claude || SOURCE_RANK[pi.source] <= SOURCE_RANK[claude.source])) {
      return resolvePi(stage, name);
    }
    if (!claude) throw noAgentModel(name);
    if (!deps.claude) throw claudeOff(name);
    const { preference, source } = claude;
    return { runtime: "claude", connectionId: preference.connectionId, model: preference.modelId, source };
  }

  /** Codex on the chosen OpenAI connection (a ChatGPT login or an API key), inside the task's sandbox. */
  async function codexRuntime(
    stage: StageContext,
    name: string,
    choice: Extract<Choice, { runtime: "codex" }>,
  ): Promise<{
    runtime: AgentRuntime;
    funding: FundingSource;
    connectionId: string;
    markRejected(): Promise<void>;
  }> {
    const codex = deps.codex;
    if (!codex || !deps.piWorkspace) throw codexOff(name);
    const credential = await deps.credentials.resolveForExecution(stage.ctx, {
      connectionId: choice.connectionId,
      requestedBy: stage.job.createdBy,
      runtime: "codex",
    });
    const runtime = (codex.runtimeFor ?? createCodexAgentRuntime)({
      workspace: deps.piWorkspace(stage),
      model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}),
      clock,
      credential: async () =>
        credential.authMethod === "oauth_subscription"
          ? {
              kind: "chatgpt",
              authJson: credential.apiKey,
              storeRefreshed: (s) => credential.storeRefreshed(s),
            }
          : { kind: "api_key", apiKey: credential.apiKey },
    });
    return {
      runtime,
      funding: connectionFunding(credential.connection.owner),
      connectionId: credential.connection.id,
      markRejected: () => credential.markRejected(),
    };
  }

  /** Claude on the chosen Anthropic connection; a preference choice is pinned to the job first. */
  async function claudeRuntime(
    stage: StageContext,
    name: string,
    choice: Extract<Choice, { runtime: "claude" }>,
    sandboxed: boolean,
  ): Promise<{
    runtime: AgentRuntime;
    model: string;
    funding: FundingSource;
    connectionId: string;
    markRejected(): Promise<void>;
  }> {
    const claude = deps.claude;
    if (!claude) throw claudeOff(name);
    const credential = await deps.credentials.resolveForExecution(stage.ctx, {
      connectionId: choice.connectionId,
      requestedBy: stage.job.createdBy,
      runtime: "claude",
    });
    if (choice.source) {
      const stored = await pin(stage.ctx, stage.job.id, {
        runtime: "claude",
        stage: name,
        source: choice.source,
        connectionId: credential.connection.id,
        connectionVersion: credential.connection.version,
        provider: credential.connection.provider,
        modelId: choice.model,
        billingSource: credential.connection.billing,
        allowFallback: false,
        fallbacks: [],
      });
      // A concurrent attempt pinned first: run what it stored so every attempt of the job uses one route.
      if (stored) {
        return claudeRuntime(
          stage,
          name,
          { runtime: "claude", connectionId: stored.connectionId, model: stored.modelId },
          sandboxed,
        );
      }
    }
    const secret = { secret: credential.apiKey, kind: credentialKind(credential) };
    const effort = choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {};
    // A task that asks for tools runs the Claude Code binary inside the skill sandbox, with its full tool set.
    const runtime =
      sandboxed && deps.piWorkspace
        ? (claude.sandboxRuntimeFor ?? createClaudeCodeSandboxRuntime)({
            workspace: deps.piWorkspace(stage),
            model: choice.model,
            ...effort,
            clock,
            credential: async () => secret,
          })
        : createClaudeAgentRuntime({
            transport: claude.transport,
            model: choice.model,
            ...effort,
            clock,
            credentials: { resolve: async () => secret },
          });
    return {
      runtime,
      model: choice.model,
      funding: connectionFunding(credential.connection.owner),
      connectionId: credential.connection.id,
      markRejected: () => credential.markRejected(),
    };
  }

  async function record(
    stage: StageContext,
    task: AgentTask,
    runtime: AgentRuntimeName,
    execution: {
      model?: string;
      funding: FundingSource;
      status: ProviderExecutionStatus;
      latencyMs: number;
      spent?: AgentSpend;
      error?: StudixError;
    },
  ): Promise<string | undefined> {
    try {
      const row = await deps.executions.recordProviderExecution(stage.ctx, {
        jobId: stage.job.id,
        provider: HARNESS_PROVIDER[runtime],
        operation: task.skill,
        attempt: stage.attempt,
        status: execution.status,
        funding: execution.funding,
        latencyMs: execution.latencyMs,
        costCents: execution.spent?.costCents ?? 0,
        ...(execution.model ? { model: execution.model } : {}),
        ...(execution.spent
          ? { inputTokens: execution.spent.inputTokens, outputTokens: execution.spent.outputTokens }
          : {}),
        ...(execution.error ? { error: execution.error.toJSON() } : {}),
      });
      return row.id;
    } catch (err) {
      log.warn("provider execution not recorded", { jobId: stage.job.id, error: String(err) });
      return undefined;
    }
  }

  function runtimeFor(stage: StageContext): AgentRuntime {
    // Reported on the stage's usage line; it names the runtime that actually ran once a run has started.
    let id = "worker-harness";
    const run = async (ctx: TenantContext, task: AgentTask): Promise<AgentRunResult> => {
      const sink = deps.events
        ? createAgentEventSink(
            deps.events,
            stage.ctx,
            {
              jobId: stage.job.id,
              ...(stage.job.projectId ? { projectId: stage.job.projectId } : {}),
              stage: task.skill,
            },
            log,
          )
        : undefined;
      try {
        return await runWith(ctx, task, sink);
      } finally {
        await sink?.flush();
      }
    };
    const runWith = async (
      ctx: TenantContext,
      task: AgentTask,
      sink: AgentEventSink | undefined,
    ): Promise<AgentRunResult> => {
      const choice = await choose(stage, task.skill).catch((err: unknown) => {
        sink?.push({
          type: "status",
          status: "failed",
          runtime: "unknown",
          error: toStudixError(err).message,
        });
        throw err;
      });
      if (sink) {
        const outer = task.onEvent;
        task = {
          ...task,
          onEvent: (event) => {
            sink.push(event);
            outer?.(event);
          },
        };
      }
      let runtime: AgentRuntime;
      let model: string | undefined;
      let markRejected: (() => Promise<void>) | undefined;
      let connectionId: string | undefined;
      // Who pays the provider: the owner of the connection the run is on (ADR 0016: recorded, not charged).
      let funding: FundingSource;
      if (
        task.inputFiles?.length &&
        choice.runtime !== "codex" &&
        !(task.tools?.length && deps.piWorkspace)
      ) {
        throw new StudixError("VALIDATION", "Input files need a tool-using task in the skill sandbox", {
          retryable: false,
          suggestedAction:
            "Give the task the read or bash tool, and run the worker with STUDIX_SANDBOX=docker.",
        });
      }
      if (choice.runtime === "claude") {
        const sandboxed = Boolean(task.tools?.length && deps.piWorkspace);
        ({ runtime, model, funding, connectionId, markRejected } = await claudeRuntime(
          stage,
          task.skill,
          choice,
          sandboxed,
        ));
        id = sandboxed ? CLAUDE_CODE_SANDBOX_RUNTIME_ID : CLAUDE_AGENT_RUNTIME_ID;
      } else if (choice.runtime === "codex") {
        ({ runtime, funding, connectionId, markRejected } = await codexRuntime(stage, task.skill, choice));
        model = choice.model;
        id = CODEX_AGENT_RUNTIME_ID;
      } else {
        // Only a task that asks for tools opens a sandbox; the provider is built lazily per stage.
        runtime = piRuntimeFor(
          choice.resolved,
          task.tools?.length && deps.piWorkspace ? deps.piWorkspace(stage) : undefined,
        );
        id = runtime.id;
        funding = choice.resolved.bindings[0]?.funding ?? "operator";
        connectionId = choice.resolved.bindings[0]?.connectionId;
      }
      const effort = choice.runtime === "pi" ? choice.resolved.reasoningEffort : choice.reasoningEffort;
      // The stage's usage line names what ran; a Pi fallback reports the connection it used.
      const routeOf = (usedConnection?: string): AgentRunRoute => ({
        runtime: choice.runtime,
        ...((usedConnection ?? connectionId) ? { connectionId: usedConnection ?? connectionId } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      const started = clock.now().getTime();
      sink?.push({ type: "status", status: "running", runtime: choice.runtime, ...(model ? { model } : {}) });
      try {
        const result = await runtime.run(ctx, task);
        for (const hostPath of filesOf(result.output)) {
          const name = hostPath.split(/[\\/]/).pop() ?? hostPath;
          const stored = await deps.storeArtifact?.(ctx, stage, hostPath).catch((err: unknown) => {
            log.warn("agent artifact upload failed", { jobId: stage.job.id, name, error: String(err) });
            return undefined;
          });
          sink?.push({ type: "artifact", name, ...stored });
        }
        // Media the agent made along the way (outside /work/out): stored for review, never a result.
        for (const hostPath of (await deps.previewFiles?.(stage).catch(() => [])) ?? []) {
          const name = hostPath.split(/[\\/]/).pop() ?? hostPath;
          const stored = await deps.storeArtifact?.(ctx, stage, hostPath).catch(() => undefined);
          if (stored) sink?.push({ type: "artifact", name, preview: true, ...stored });
        }
        sink?.push({
          type: "status",
          status: "succeeded",
          runtime: choice.runtime,
          ...((result.model ?? model) ? { model: result.model ?? model } : {}),
        });
        funding = result.funding ?? funding;
        const providerExecutionId = await record(stage, task, choice.runtime, {
          model: result.model ?? model,
          funding,
          status: "succeeded",
          latencyMs: clock.now().getTime() - started,
          spent: result,
        });
        log.info("agent stage ran", {
          jobId: stage.job.id,
          stage: task.skill,
          runtime: choice.runtime,
          model: result.model ?? model,
          turns: result.turns,
          costCents: result.costCents,
        });
        return {
          ...result,
          funding,
          route: routeOf(result.resolved?.connectionId),
          ...(providerExecutionId ? { providerExecutionId } : {}),
        };
      } catch (err) {
        const error = toStudixError(err);
        sink?.push({ type: "status", status: "failed", runtime: choice.runtime, error: error.message });
        // The Pi loop reports rejected keys itself; the Claude runtime leaves it to its caller.
        if (error.code === "UNAUTHENTICATED" && markRejected) {
          await markRejected().catch((e: unknown) => {
            log.warn("rejected key not marked invalid", { jobId: stage.job.id, error: String(e) });
          });
        }
        const spent = agentSpendOf(error);
        // The Pi loop names the connection that spent when a fallback ran.
        const paidBy = FUNDING_SOURCES.find((f) => f === error.details?.funding);
        if (paidBy) funding = paidBy;
        const providerExecutionId = await record(stage, task, choice.runtime, {
          model: spent?.model ?? model,
          funding,
          status: EXECUTION_STATUS[error.code] ?? "failed",
          latencyMs: clock.now().getTime() - started,
          ...(spent ? { spent } : {}),
          error,
        });
        if (!spent) throw error;
        // Funding rides on the spend even when the execution was not recorded, so it is never billed as operator.
        throw new StudixError(error.code, error.message, {
          retryable: error.retryable,
          suggestedAction: error.suggestedAction,
          details: {
            ...error.details,
            spent: {
              ...spent,
              funding,
              route: routeOf(),
              ...(providerExecutionId ? { providerExecutionId } : {}),
            },
          },
          cause: error,
        });
      }
    };
    return {
      get id() {
        return id;
      },
      run(ctx, task) {
        const pending = run(ctx, task);
        const settled = pending.then(
          () => undefined,
          () => undefined,
        );
        inFlight.add(settled);
        void settled.then(() => inFlight.delete(settled));
        return pending;
      },
    };
  }

  async function idle(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([Promise.all([...inFlight]).then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { runtimeFor, idle };
}

/** Host paths of what the agent left in /work/out; only their names reach events. */
function filesOf(output: unknown): string[] {
  const files = (output as { files?: unknown } | null)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

function sameSelection(a: JobAgentSelection, b: unknown): boolean {
  const parsed = JobAgentSelection.safeParse(b);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(a);
}

const RequestedModel = z
  .object({
    agentModel: z.object({ connectionId: z.string(), provider: z.string(), modelId: z.string() }).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    agent: JobAgentSelection.optional(),
  })
  .passthrough();

/** The Pi agent model and effort `studix_create_video` checked and stored on the job, if any. */
export function jobModelRequest(
  payload: unknown,
  stage?: string,
): {
  request?: { choice?: ModelChoice; reasoningEffort?: ReasoningEffort };
} {
  const parsed = RequestedModel.safeParse(payload ?? {});
  if (!parsed.success) return {};
  const agent = stage ? stageAgentSelection(payload, stage) : parsed.data.agent;
  // `agent` is the current field; top-level agentModel/reasoningEffort are kept for jobs queued before it.
  const agentModel =
    agent?.runtime === "pi" && agent.modelId
      ? { connectionId: agent.connectionId, provider: agent.provider, modelId: agent.modelId }
      : parsed.data.agentModel;
  const reasoningEffort = agent?.runtime === "pi" ? agent.reasoningEffort : parsed.data.reasoningEffort;
  if (!agentModel && !reasoningEffort) return {};
  return {
    request: {
      ...(agentModel ? { choice: agentModel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}
