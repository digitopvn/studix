import type { AgentCap, AgentRunResult, AgentRuntime, AgentTask, TenantContext } from "@studix/core";
import {
  type Clock,
  type ErrorCode,
  redactDeep,
  StudixError,
  systemClock,
  toStudixError,
} from "@studix/shared";

/** Cumulative usage a loop reports while it runs, so caps stop it mid-run instead of after the fact. */
export interface AgentUsageReport {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  model?: string;
}

/**
 * A task as the loop sees it: the signal combines the caller's signal, the deadline and every cap, and
 * `reportUsage` lets the runtime trip a cap as soon as the loop crosses it.
 */
export type BoundedAgentTask = AgentTask & {
  signal: AbortSignal;
  reportUsage(usage: AgentUsageReport): void;
};

/**
 * The actual agent loop (model calls + tool use). It must stop all of its work, including any process it
 * started, when `task.signal` aborts; the runtime waits for it to settle before it reports the stop.
 */
export type AgentLoop = (ctx: TenantContext, task: BoundedAgentTask) => Promise<AgentRunResult>;

export interface BoundedAgentRuntimeOptions {
  id: string;
  loop: AgentLoop;
  clock?: Clock;
  /** How long a loop has to settle after an abort before the run is reported INTERNAL. */
  stopGraceMs?: number;
}

const DEFAULT_STOP_GRACE_MS = 5_000;

export function assertAgentTask(task: AgentTask, now: Date): void {
  const problems: string[] = [];
  if (!task.skill?.trim()) problems.push("skill is required");
  if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1)
    problems.push("maxTurns must be an integer >= 1");
  if (!Number.isFinite(task.maxCostCents) || task.maxCostCents < 0)
    problems.push("maxCostCents must be >= 0");
  if (task.maxTokens !== undefined && (!Number.isInteger(task.maxTokens) || task.maxTokens < 1))
    problems.push("maxTokens must be an integer >= 1");
  if (problems.length > 0) {
    throw new StudixError("VALIDATION", `Invalid agent task: ${problems.join("; ")}`, {
      details: { problems },
    });
  }
  if (task.deadlineAt && task.deadlineAt.getTime() <= now.getTime()) {
    throw new StudixError("TIMEOUT", "agent task deadline already passed", {
      retryable: false,
      details: { cap: "time" satisfies AgentCap },
    });
  }
}

export function abortReason(signal: AbortSignal): StudixError {
  const reason: unknown = signal.reason;
  return reason instanceof StudixError ? reason : new StudixError("CANCELLED", "agent task was cancelled");
}

const CAP_CODES: Record<AgentCap, ErrorCode> = {
  turns: "PROVIDER_ERROR",
  tokens: "BUDGET_EXCEEDED",
  cost: "BUDGET_EXCEEDED",
  time: "TIMEOUT",
};

/** The error a run stops with when it reaches a cap; `details.cap` names the cap. Never retryable. */
export function agentCapError(cap: AgentCap, message: string, details: Record<string, unknown> = {}) {
  return new StudixError(CAP_CODES[cap], message, { retryable: false, details: { ...details, cap } });
}

/** The cap a failed run stopped at, or undefined when it failed for another reason. */
export function agentCapOf(err: unknown): AgentCap | undefined {
  const cap = err instanceof StudixError ? err.details?.cap : undefined;
  return cap === "turns" || cap === "tokens" || cap === "cost" || cap === "time" ? cap : undefined;
}

/** The first cap `usage` crosses, as the error that stops the run. */
export function capExceeded(
  task: Pick<AgentTask, "maxTurns" | "maxCostCents" | "maxTokens">,
  usage: Omit<AgentUsageReport, "model">,
): StudixError | undefined {
  if (usage.turns > task.maxTurns) {
    return agentCapError("turns", `agent used ${usage.turns} turns, over the ${task.maxTurns} limit`, {
      limit: task.maxTurns,
      used: usage.turns,
    });
  }
  const tokens = usage.inputTokens + usage.outputTokens;
  if (task.maxTokens !== undefined && tokens > task.maxTokens) {
    return agentCapError("tokens", `agent used ${tokens} tokens, over the ${task.maxTokens} limit`, {
      limit: task.maxTokens,
      used: tokens,
    });
  }
  if (usage.costCents > task.maxCostCents) {
    return agentCapError(
      "cost",
      `agent cost ${usage.costCents.toFixed(2)}¢ exceeds the ${task.maxCostCents}¢ task limit`,
      { limit: task.maxCostCents, used: usage.costCents },
    );
  }
  return undefined;
}

/** What a failed run had already spent, as reported by the agent before it stopped. */
export interface AgentSpend {
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  model?: string;
  /** Set by a caller that recorded the failed run as a provider execution. */
  providerExecutionId?: string;
}

/** The spend carried by an error from an agent runtime's `run`, if the agent reported any. */
export function agentSpendOf(err: unknown): AgentSpend | undefined {
  const spent = err instanceof StudixError ? err.details?.spent : undefined;
  return spent && typeof spent === "object" ? (spent as AgentSpend) : undefined;
}

/**
 * A run that fails after the agent reported usage still cost money. The spend rides on the error so the
 * caller can bill it, and the error is no longer retryable: a retry would pay again.
 */
export function withSpend(err: StudixError, spent: AgentSpend): StudixError {
  if (!(spent.costCents > 0 || spent.inputTokens > 0 || spent.outputTokens > 0)) return err;
  return new StudixError(err.code, err.message, {
    retryable: false,
    suggestedAction: err.suggestedAction,
    details: { ...err.details, spent },
    cause: err,
  });
}

function finiteMax(next: number, prev: number): number {
  return Number.isFinite(next) ? Math.max(next, prev) : Number.NaN;
}

/**
 * Wrap an agent loop so every run honours the AgentRuntime contract: a validated task; the deadline,
 * the caller's signal and every cap (turns, tokens, cost, checked on each usage report and on the result)
 * abort the loop's signal; and the run settles only once the loop has stopped. A loop that does not settle
 * within `stopGraceMs` of the abort is reported INTERNAL, never as a clean stop. Outputs are redacted.
 */
export function createBoundedAgentRuntime(options: BoundedAgentRuntimeOptions): AgentRuntime {
  const clock = options.clock ?? systemClock;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  return {
    id: options.id,
    async run(ctx, task) {
      assertAgentTask(task, clock.now());
      const controller = new AbortController();
      const stop = (reason: StudixError) => {
        if (!controller.signal.aborted) controller.abort(reason);
      };
      const onCallerAbort = () => stop(abortReason(task.signal!));
      if (task.signal?.aborted) onCallerAbort();
      task.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const deadline = task.deadlineAt;
      const timer = deadline
        ? setTimeout(
            () => stop(agentCapError("time", "agent task deadline reached")),
            Math.min(2 ** 31 - 1, Math.max(0, deadline.getTime() - clock.now().getTime())),
          )
        : undefined;

      let usage: AgentSpend = { turns: 0, inputTokens: 0, outputTokens: 0, costCents: 0 };
      const reportUsage = (report: AgentUsageReport) => {
        if (controller.signal.aborted) return;
        usage = {
          turns: finiteMax(report.turns, usage.turns),
          inputTokens: finiteMax(report.inputTokens, usage.inputTokens),
          outputTokens: finiteMax(report.outputTokens, usage.outputTokens),
          costCents: finiteMax(report.costCents, usage.costCents),
          model: report.model ?? usage.model,
        };
        if ([usage.turns, usage.inputTokens, usage.outputTokens, usage.costCents].some(Number.isNaN)) {
          stop(new StudixError("PROVIDER_ERROR", "agent reported invalid usage", { retryable: false }));
          return;
        }
        const over = capExceeded(task, usage);
        if (over) stop(over);
      };

      type Settled = { ok: true; result: AgentRunResult } | { ok: false; error: unknown };
      let loop: Promise<Settled>;
      try {
        loop = options.loop(ctx, { ...task, signal: controller.signal, reportUsage }).then(
          (result): Settled => ({ ok: true, result }),
          (error: unknown): Settled => ({ ok: false, error }),
        );
      } catch (error) {
        loop = Promise.resolve({ ok: false, error });
      }
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const first = await Promise.race([loop, aborted]);
        if (first === "aborted") {
          // The loop was told to stop; it has a grace period to actually do so.
          const grace = new Promise<"timeout">((resolve) => {
            graceTimer = setTimeout(() => resolve("timeout"), stopGraceMs);
          });
          const late = await Promise.race([loop, grace]);
          const reason = abortReason(controller.signal);
          if (late === "timeout") {
            throw new StudixError("INTERNAL", "agent loop did not stop after it was aborted", {
              retryable: false,
              details: { stopCode: reason.code, cap: reason.details?.cap, stopGraceMs },
            });
          }
          throw withSpend(reason, usage);
        }
        if (!first.ok) throw withSpend(toStudixError(first.error, "PROVIDER_ERROR"), usage);
        const result = first.result;
        if (!Number.isFinite(result.costCents)) {
          throw new StudixError("PROVIDER_ERROR", "agent reported an invalid cost", { retryable: false });
        }
        const over = capExceeded(task, result);
        if (over) {
          throw withSpend(over, {
            turns: result.turns,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costCents: result.costCents,
            model: result.model,
          });
        }
        return { ...result, output: redactDeep(result.output) };
      } catch (err) {
        throw toStudixError(err, "PROVIDER_ERROR");
      } finally {
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        task.signal?.removeEventListener("abort", onCallerAbort);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
