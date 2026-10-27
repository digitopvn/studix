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

/** Deterministic AgentRuntime for tests. Goes through the same limit enforcement as the real one. */
export function createFakeAgentRuntime(
  respond: FakeAgentResponder,
  options: { id?: string; clock?: Clock } = {},
): FakeAgentRuntime {
  const calls: Array<{ ctx: TenantContext; task: AgentTask }> = [];
  const runtime = createBoundedAgentRuntime({
    id: options.id ?? "fake",
    clock: options.clock,
    loop: async (ctx, task) => {
      calls.push({ ctx, task });
      const reply = await respond(ctx, task);
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
