import { USAGE_KINDS } from "@studix/billing";
import type {
  AgentCap,
  AgentHandoff,
  AgentInputImage,
  AgentRunResult,
  AgentRunRoute,
  AgentStageLimits,
  AgentToolDefinition,
  Approval,
  FundingSource,
} from "@studix/core";
import { AGENT_RUNTIMES, FUNDING_SOURCES, REASONING_EFFORTS, stageAgentSelection } from "@studix/core";
import { newId, redactDeep, StudixError, toStudixError } from "@studix/shared";
import { z } from "zod";
import { stageCacheKey } from "./stage-runner.ts";
import { StageFailedAfterSpend, StageSuspended } from "./stage-signals.ts";
import type { StageContext, StageDefinition, StageOutput, StageUsage } from "./workflow-types.ts";

/** Where an agent stage runs: inside the worker (`harness`, the default) or on the MCP client's agent (`host`). */
export const AGENT_STAGE_MODES = ["harness", "host"] as const;
export type AgentStageMode = (typeof AGENT_STAGE_MODES)[number];

export interface AgentStageSpec<I extends z.ZodType, O extends z.ZodType<StageOutput>> {
  name: string;
  /** Bumped whenever the instructions, limits or schemas change: part of the cache key. */
  version: number;
  inputSchema: I;
  outputSchema: O;
  instructions: string;
  /** What the agent sees of the parsed stage input (redacted before it leaves the worker). */
  taskInput(input: z.infer<I>): Record<string, unknown>;
  /** Limits of the first run; each overrun approval doubles every one of them. */
  limits: Omit<AgentStageLimits, "tools">;
  /** Per-job limits of the first run (for example by the agent's reasoning effort); `limits` otherwise. */
  limitsFor?(job: StageContext["job"]): Omit<AgentStageLimits, "tools">;
  /**
   * Images the model looks at with the input (vision), in harness mode; a runtime or model that cannot
   * read images fails the stage with UNAVAILABLE before it spends anything. Host tasks carry none.
   */
  images?(input: z.infer<I>): AgentInputImage[];
  /** Tools the agent may call (the allowlist); none by default. */
  tools?: AgentToolDefinition[];
  /**
   * False when the output points at files that live only for the job (a sandbox render), or when
   * the same input should make a new result each run. Cached by input otherwise.
   */
  cacheable?: boolean;
  /**
   * In the harness, an output that fails the schema earns one more run of the same agent, under what is left of
   * the limits: the task input gains `repair: { issues: [{ path, message }], output }` (its rejected output).
   * The instructions must say what to do with `repair`. Host runs answer once and get no repair turn.
   */
  repairTurn?: boolean;
}

const CAP_LABELS: Record<AgentCap, string> = {
  turns: "turn",
  tokens: "token",
  cost: "cost",
  time: "time",
};

const AgentModePayload = z.object({ agentMode: z.enum(AGENT_STAGE_MODES).optional() });

function stageMode(stage: StageContext): AgentStageMode {
  const parsed = AgentModePayload.safeParse(stage.job.payload);
  if (!parsed.success) {
    throw new StudixError("VALIDATION", "payload.agentMode must be 'harness' or 'host'", {
      retryable: false,
      details: { issues: parsed.error.issues.slice(0, 5) },
    });
  }
  return parsed.data.agentMode ?? "harness";
}

function scaled(limits: Omit<AgentStageLimits, "tools">, factor: number): Omit<AgentStageLimits, "tools"> {
  return {
    maxTurns: limits.maxTurns * factor,
    maxTokens: limits.maxTokens * factor,
    maxCostCents: limits.maxCostCents * factor,
    timeoutMs: limits.timeoutMs * factor,
  };
}

function capOf(err: unknown): AgentCap | undefined {
  const cap = err instanceof StudixError ? err.details?.cap : undefined;
  return cap === "turns" || cap === "tokens" || cap === "cost" || cap === "time" ? cap : undefined;
}

interface Spend {
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  model?: string;
  providerExecutionId?: string;
  funding?: FundingSource;
  route?: AgentRunRoute;
}

function routeOf(value: unknown): AgentRunRoute | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<AgentRunRoute>;
  const runtime = AGENT_RUNTIMES.find((x) => x === r.runtime);
  if (!runtime) return undefined;
  return {
    runtime,
    ...(typeof r.connectionId === "string" ? { connectionId: r.connectionId } : {}),
    ...(REASONING_EFFORTS.find((e) => e === r.reasoningEffort) ? { reasoningEffort: r.reasoningEffort } : {}),
  };
}

function spendOf(err: unknown): Spend | undefined {
  const spent = err instanceof StudixError ? err.details?.spent : undefined;
  if (!spent || typeof spent !== "object") return undefined;
  const s = spent as Partial<Spend>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    costCents: n(s.costCents),
    inputTokens: n(s.inputTokens),
    outputTokens: n(s.outputTokens),
    turns: n(s.turns),
    model: typeof s.model === "string" ? s.model : undefined,
    providerExecutionId: typeof s.providerExecutionId === "string" ? s.providerExecutionId : undefined,
    funding: FUNDING_SOURCES.find((f) => f === s.funding),
    route: routeOf(s.route),
  };
}

/**
 * A creative stage an agent performs, under one contract (input schema, output schema, limits) in both
 * modes. In the harness the worker's AgentRuntime runs it with every limit as a hard cap; in host mode the
 * job parks in `waiting_host` and the MCP client's own agent fetches the task and submits the output.
 * Reaching a cap never fails silently: the stage parks for an `agent.overrun` approval, and each approval
 * grants one more run with every limit doubled. A rejected overrun fails the stage.
 */
export function createAgentStage<I extends z.ZodType, O extends z.ZodType<StageOutput>>(
  spec: AgentStageSpec<I, O>,
): StageDefinition {
  const toolNames = (spec.tools ?? []).map((t) => t.name);
  const outputJsonSchema = (): Record<string, unknown> =>
    z.toJSONSchema(spec.outputSchema, { unrepresentable: "any" }) as Record<string, unknown>;

  const overrun = (cap: AgentCap, limits: Omit<AgentStageLimits, "tools">, usage: StageUsage[]) =>
    new StageSuspended(
      {
        kind: "approval",
        action: "agent.overrun",
        scopeKey: `agent:${spec.name}`,
        reason: `Agent stage ${spec.name} reached its ${CAP_LABELS[cap]} limit; approve to run it again with every limit doubled.`,
        estimatedCostCents: limits.maxCostCents * 2,
      },
      usage,
    );

  /** Park again on the overrun request that is still open, without running (and paying for) the agent. */
  const stillWaiting = (pending: Approval) =>
    new StageSuspended({
      kind: "approval",
      action: "agent.overrun",
      scopeKey: `agent:${spec.name}`,
      reason: pending.reason,
      ...(pending.estimatedCostCents !== undefined ? { estimatedCostCents: pending.estimatedCostCents } : {}),
    });

  /**
   * Each harness run is billed on its own line: the run id keeps a second paid run of the same round and
   * attempt (a parked job resumes at the same attempt) from being dropped as a duplicate by the ledger.
   */
  const usageLine = (
    mode: AgentStageMode,
    round: number,
    runtime: string,
    spend: Spend,
    cap?: AgentCap,
  ): StageUsage => ({
    item: mode === "harness" ? `agent-r${round}-${newId("run")}` : `agent-host-r${round}`,
    kind: USAGE_KINDS.agentRun,
    quantity: spend.inputTokens + spend.outputTokens,
    unit: "token",
    costCents: mode === "harness" ? spend.costCents : 0,
    ...(mode === "harness" && spend.providerExecutionId
      ? { providerExecutionId: spend.providerExecutionId }
      : {}),
    // A host run is paid by the MCP client's own agent; a harness run by whoever owns the key it ran on.
    ...(mode === "host" ? { funding: "host" as const } : spend.funding ? { funding: spend.funding } : {}),
    metadata: {
      mode,
      runtime,
      model: spend.model,
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      turns: spend.turns,
      round,
      // What ran, for the job's stage list; a connection id, never its key.
      ...(spend.route
        ? {
            agentRuntime: spend.route.runtime,
            ...(spend.route.connectionId ? { connectionId: spend.route.connectionId } : {}),
            ...(spend.route.reasoningEffort ? { reasoningEffort: spend.route.reasoningEffort } : {}),
          }
        : {}),
      ...(cap ? { cap } : {}),
    },
  });

  const validOutput = (output: unknown, usage: StageUsage[]): StageOutput => {
    const parsed = spec.outputSchema.safeParse(output);
    if (parsed.success) return parsed.data as StageOutput;
    const where = issuesOf(parsed.error.issues)
      .slice(0, 3)
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ");
    throw new StageFailedAfterSpend(
      new StudixError("VALIDATION", `Agent output of stage ${spec.name} fails its schema (${where})`, {
        retryable: false,
        details: { issues: parsed.error.issues.slice(0, 10) },
      }),
      usage,
    );
  };

  return {
    name: spec.name,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    hostOutputSchema: spec.outputSchema,
    retry: "never",
    // The agent that runs the stage is part of the key: another runtime, model, effort or connection (a role's or
    // the job's) must not reuse this output.
    cacheKey: (s) =>
      spec.cacheable === false
        ? undefined
        : stageCacheKey(spec.name, spec.version, {
            input: s.input,
            agent: agentKeyOf(s.job.payload, spec.name),
          }),
    // Host work costs Studix nothing; an invalid mode is reported by `run`, so the estimate stays conservative.
    // The reservation never exceeds what is left of the job budget: `run` caps the agent at that amount.
    estimateCostCents: (s) =>
      AgentModePayload.safeParse(s.job.payload).data?.agentMode === "host"
        ? 0
        : Math.min(spec.limits.maxCostCents, remainingBudget(s.job)),
    async run(s) {
      const agents = s.agents;
      if (!agents) {
        throw new StudixError(
          "UNAVAILABLE",
          `Agent stage ${spec.name} needs a worker wired with agent services`,
          {
            retryable: false,
          },
        );
      }
      const mode = stageMode(s);

      const latest = await agents.latestOverrun();
      if (latest?.status === "rejected") {
        throw new StudixError("FORBIDDEN", `The overrun of agent stage ${spec.name} was rejected`, {
          retryable: false,
          details: { approvalId: latest.id },
        });
      }
      // Still undecided: running again would pay for the same capped run and reach the same open request.
      if (latest?.status === "pending") throw stillWaiting(latest);
      if (latest?.status === "approved" && latest.decidedBy?.type === "user") {
        await agents.consumeOverrun(latest.id);
      }
      const round = await agents.grantedOverruns();
      const limits = scaled(spec.limitsFor?.(s.job) ?? spec.limits, 2 ** round);
      const input = spec.taskInput(s.input as z.infer<I>);

      if (mode === "host") return runOnHost(s, round, limits, input);

      const runtime = agents.runtime;
      if (!runtime) {
        throw new StudixError("UNAVAILABLE", "This worker runs no agent harness", {
          retryable: false,
          suggestedAction:
            "Submit the job with payload.agentMode 'host' and complete the stage from your MCP client.",
        });
      }
      const maxCostCents = Math.min(limits.maxCostCents, remainingBudget(s.job));
      if (maxCostCents <= 0) {
        throw new StudixError("BUDGET_EXCEEDED", `No budget left for agent stage ${spec.name}`, {
          retryable: false,
          details: { budgetCents: s.job.budgetCents, spentCents: s.job.spentCents },
        });
      }
      const images = spec.images?.(s.input as z.infer<I>);
      const usage: StageUsage[] = [];
      /** Caps of one run: the first gets the stage's limits, a repair turn only what the first left of them. */
      interface RunCaps {
        maxCostCents: number;
        maxTurns: number;
        maxTokens: number;
        deadlineAt: Date;
        /** True when the job budget, not the stage limit, set `maxCostCents`. */
        budgetBound: boolean;
        /** The trace records a schema failure of this run as a warning: a repair turn follows it. */
        willRepair: boolean;
      }
      let firstRun: AgentRunResult | undefined;
      /** One paid harness run; its spend joins `usage` whether it returns or throws. */
      const runOnce = async (taskInput: Record<string, unknown>, caps: RunCaps): Promise<unknown> => {
        let result: AgentRunResult;
        try {
          result = await runtime.run(s.ctx, {
            skill: spec.name,
            instructions: spec.instructions,
            input: taskInput,
            tools: spec.tools,
            ...(images?.length ? { images } : {}),
            outputSchema: outputJsonSchema(),
            maxTurns: caps.maxTurns,
            maxTokens: caps.maxTokens,
            maxCostCents: caps.maxCostCents,
            deadlineAt: caps.deadlineAt,
            signal: s.signal,
            ...(caps.willRepair ? { willRepair: true } : {}),
            outputIssues: (output) => {
              const checked = spec.outputSchema.safeParse(output);
              return checked.success ? [] : issuesOf(checked.error.issues);
            },
          });
        } catch (err) {
          const error = toStudixError(err);
          const spend = spendOf(error);
          const cap = capOf(error);
          if (spend) usage.push(usageLine("harness", round, runtime.id, spend, cap));
          if (cap && !s.signal.aborted) {
            if (cap === "cost" && caps.budgetBound) {
              throw new StageFailedAfterSpend(
                new StudixError(
                  "BUDGET_EXCEEDED",
                  `Agent stage ${spec.name} used the rest of the job budget`,
                  {
                    retryable: false,
                    suggestedAction: "Raise the job budget, then submit a new job.",
                    details: { budgetCents: s.job.budgetCents, spentCents: s.job.spentCents, cap },
                  },
                ),
                usage,
              );
            }
            throw overrun(cap, limits, usage);
          }
          if (usage.length > 0) throw new StageFailedAfterSpend(error, usage);
          throw error;
        }
        usage.push(usageLine("harness", round, runtime.id, result));
        firstRun ??= result;
        return redactDeep(result.output);
      };

      // A caller that already sends a `repair` is running its own repair turn: it gets no second one here.
      const repairs = spec.repairTurn === true && input.repair === undefined;
      const firstDeadline = new Date(Date.now() + limits.timeoutMs);
      const first = await runOnce(input, {
        maxCostCents,
        maxTurns: limits.maxTurns,
        maxTokens: limits.maxTokens,
        deadlineAt: firstDeadline,
        budgetBound: maxCostCents < limits.maxCostCents,
        willRepair: repairs,
      });
      const parsed = spec.outputSchema.safeParse(first);
      if (parsed.success) return { output: parsed.data as StageOutput, usage };
      // One repair turn: the agent gets its own output back with every schema issue, under what the first run
      // left of the stage's limits (cost, turns, tokens and its deadline), never a fresh set.
      const spent = costOf(usage);
      const byBudget = remainingBudget(s.job) - spent;
      const caps: RunCaps = {
        maxCostCents: Math.min(limits.maxCostCents - spent, byBudget),
        maxTurns: limits.maxTurns - (firstRun?.turns ?? limits.maxTurns),
        maxTokens: limits.maxTokens - ((firstRun?.inputTokens ?? 0) + (firstRun?.outputTokens ?? 0)),
        deadlineAt: firstDeadline,
        budgetBound: byBudget < limits.maxCostCents - spent,
        willRepair: false,
      };
      const usable =
        caps.maxCostCents > 0 &&
        caps.maxTurns >= 1 &&
        caps.maxTokens >= 1 &&
        caps.deadlineAt.getTime() > Date.now();
      if (!repairs || !usable || s.signal.aborted) return { output: validOutput(first, usage), usage };
      const repair = { issues: issuesOf(parsed.error.issues), output: first };
      let second: unknown;
      try {
        second = await runOnce({ ...input, repair }, caps);
      } catch (err) {
        // A cap parks the stage for an overrun approval like any run; another failure (a provider error)
        // reports the first output's schema failure with both runs' spend.
        if (s.signal.aborted || err instanceof StageSuspended) throw err;
        return { output: validOutput(first, usage), usage };
      }
      return { output: validOutput(second, usage), usage };
    },
  };

  async function runOnHost(
    s: StageContext,
    round: number,
    limits: Omit<AgentStageLimits, "tools">,
    input: Record<string, unknown>,
  ) {
    const handoff: AgentHandoff | undefined = await s.agents!.latestHandoff();
    if (handoff && handoff.round === round) {
      if (handoff.status === "submitted") {
        const usage = [
          usageLine("host", round, "host", {
            costCents: 0,
            inputTokens: handoff.usage?.inputTokens ?? 0,
            outputTokens: handoff.usage?.outputTokens ?? 0,
            turns: handoff.usage?.turns ?? 0,
            model: handoff.usage?.model,
          }),
        ];
        return { output: validOutput(handoff.output, usage), usage };
      }
      if (handoff.status === "expired") throw overrun("time", limits, []);
    }
    throw new StageSuspended({
      kind: "host",
      task: {
        round,
        instructions: spec.instructions,
        input: redactDeep(input),
        outputSchema: outputJsonSchema(),
        limits: { ...limits, tools: toolNames },
      },
    });
  }
}

/** Zod issues as `path: message` pairs an agent (or a reader of a warning) can act on. */
function issuesOf(issues: readonly z.core.$ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.slice(0, 10).map((i) => ({
    path: i.path.length > 0 ? i.path.map(String).join(".") : "(root)",
    message: i.message,
  }));
}

const costOf = (usage: readonly StageUsage[]) => usage.reduce((sum, u) => sum + (u.costCents ?? 0), 0);

function remainingBudget(job: { budgetCents?: number; spentCents: number }): number {
  return job.budgetCents === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, job.budgetCents - job.spentCents);
}

/** What picks the agent of one stage: its selection (role or job agent), the roles, the mode and the legacy planner. */
export function agentKeyOf(payload: unknown, stage: string): unknown {
  const p = (payload ?? {}) as { roles?: unknown; agentMode?: unknown; planner?: unknown };
  return {
    selection: stageAgentSelection(payload, stage) ?? null,
    roles: p.roles ?? null,
    agentMode: p.agentMode ?? null,
    planner: p.planner ?? null,
  };
}
