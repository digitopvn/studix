import type { AgentRunResult, AgentRuntime, AgentTask, TenantContext } from "@studix/core";
import { type Clock, StudixError, systemClock, toStudixError } from "@studix/shared";

/** A task whose signal is always present (it combines the caller's signal and the deadline). */
export type BoundedAgentTask = AgentTask & { signal: AbortSignal };

/** The actual agent loop (model calls + tool use). The bounded runtime owns limits around it. */
export type AgentLoop = (ctx: TenantContext, task: BoundedAgentTask) => Promise<AgentRunResult>;

export interface BoundedAgentRuntimeOptions {
  id: string;
  loop: AgentLoop;
  clock?: Clock;
}

export function assertAgentTask(task: AgentTask, now: Date): void {
  const problems: string[] = [];
  if (!task.skill?.trim()) problems.push("skill is required");
  if (!Number.isInteger(task.maxTurns) || task.maxTurns < 1)
    problems.push("maxTurns must be an integer >= 1");
  if (!Number.isFinite(task.maxCostCents) || task.maxCostCents < 0)
    problems.push("maxCostCents must be >= 0");
  if (problems.length > 0) {
    throw new StudixError("VALIDATION", `Invalid agent task: ${problems.join("; ")}`, {
      details: { problems },
    });
  }
  if (task.deadlineAt && task.deadlineAt.getTime() <= now.getTime()) {
    throw new StudixError("TIMEOUT", "agent task deadline already passed", { retryable: false });
  }
}

export function abortReason(signal: AbortSignal): StudixError {
  const reason: unknown = signal.reason;
  return reason instanceof StudixError ? reason : new StudixError("CANCELLED", "agent task was cancelled");
}

/**
 * Wrap an agent loop so every run honours the AgentRuntime contract: validated task, deadline and
 * caller signal enforced (the loop is raced against abort, so a stuck loop cannot hold the caller),
 * and results over maxTurns or maxCostCents rejected.
 */
export function createBoundedAgentRuntime(options: BoundedAgentRuntimeOptions): AgentRuntime {
  const clock = options.clock ?? systemClock;
  return {
    id: options.id,
    async run(ctx, task) {
      assertAgentTask(task, clock.now());
      const controller = new AbortController();
      const onCallerAbort = () => controller.abort(abortReason(task.signal!));
      if (task.signal?.aborted) onCallerAbort();
      task.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const deadline = task.deadlineAt;
      const timer = deadline
        ? setTimeout(
            () =>
              controller.abort(
                new StudixError("TIMEOUT", "agent task deadline reached", { retryable: false }),
              ),
            Math.max(0, deadline.getTime() - clock.now().getTime()),
          )
        : undefined;
      let rejectOnAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        rejectOnAbort = () => reject(abortReason(controller.signal));
        if (controller.signal.aborted) rejectOnAbort();
        else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      try {
        const result = await Promise.race([
          options.loop(ctx, { ...task, signal: controller.signal }),
          aborted,
        ]);
        if (result.turns > task.maxTurns) {
          throw new StudixError(
            "PROVIDER_ERROR",
            `agent used ${result.turns} turns, over the ${task.maxTurns} limit`,
            {
              retryable: false,
            },
          );
        }
        if (!Number.isFinite(result.costCents) || result.costCents > task.maxCostCents) {
          throw new StudixError(
            "BUDGET_EXCEEDED",
            `agent cost ${result.costCents}¢ exceeds the ${task.maxCostCents}¢ task limit`,
            {
              retryable: false,
              ...(Number.isFinite(result.costCents) ? { details: { spentCents: result.costCents } } : {}),
            },
          );
        }
        return result;
      } catch (err) {
        throw toStudixError(err, "PROVIDER_ERROR");
      } finally {
        if (timer) clearTimeout(timer);
        task.signal?.removeEventListener("abort", onCallerAbort);
        if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
        aborted.catch(() => {});
      }
    },
  };
}
