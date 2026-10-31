import type { AgentRunResult, AgentRuntime, AgentTask, TenantContext } from "@studix/core";
import type { Clock } from "@studix/shared";
import { type BoundedAgentTask, createBoundedAgentRuntime } from "./bounded-agent-runtime.ts";

/** Scripted reply of the fake runtime; omitted counters default to a one-turn, free run. */
export type FakeAgentReply = Partial<AgentRunResult> & { output: unknown };

export type FakeAgentResponder = (
  ctx: TenantContext,
  task: BoundedAgentTask,
) => FakeAgentReply | Promise<FakeAgentReply>;

export interface FakeAgentRuntime extends AgentRuntime {
  /** Every task received, in order (for assertions). */
  readonly calls: ReadonlyArray<{ ctx: TenantContext; task: AgentTask }>;
}

/**
 * Deterministic AgentRuntime for tests. Goes through the same limit enforcement as the real one; a
 * responder can call `task.reportUsage` to simulate an agent crossing a cap mid-run.
 */
export function createFakeAgentRuntime(
  respond: FakeAgentResponder,
  options: { id?: string; clock?: Clock; stopGraceMs?: number } = {},
): FakeAgentRuntime {
  const calls: Array<{ ctx: TenantContext; task: AgentTask }> = [];
  const runtime = createBoundedAgentRuntime({
    id: options.id ?? "fake",
    clock: options.clock,
    stopGraceMs: options.stopGraceMs,
    loop: async (ctx, task) => {
      calls.push({ ctx, task });
      // Like a real agent process, the fake stops as soon as it is told to.
      const reply = await new Promise<FakeAgentReply>((resolve, reject) => {
        const onAbort = () => reject(task.signal.reason);
        if (task.signal.aborted) return onAbort();
        task.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => respond(ctx, task))
          .then(resolve, reject)
          .finally(() => task.signal.removeEventListener("abort", onAbort));
      });
      return {
        output: reply.output,
        turns: reply.turns ?? 1,
        costCents: reply.costCents ?? 0,
        inputTokens: reply.inputTokens ?? 0,
        outputTokens: reply.outputTokens ?? 0,
        model: reply.model ?? "fake-model",
      };
    },
  });
  return { id: runtime.id, run: runtime.run, calls };
}
