import type { AgentTask } from "@studix/core";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentStage } from "../src/agent-stage.ts";
import { StageSuspended } from "../src/stage-signals.ts";
import type { StageContext } from "../src/workflow-types.ts";

const limits = { maxTurns: 4, maxTokens: 1_000, maxCostCents: 30, timeoutMs: 60_000 };

const stage = createAgentStage({
  name: "test.repair",
  version: 1,
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.object({ title: z.string().max(5) }),
  instructions: "Write a title.",
  taskInput: (input) => input,
  limits,
  repairTurn: true,
});

type Reply = { output: unknown } | { error: Error };

/** A harness double that answers from a queue and keeps each task it was given. */
function setup(replies: Reply[], budgetCents = 1_000) {
  const tasks: AgentTask[] = [];
  const runtime = {
    id: "fake",
    async run(_ctx: unknown, task: AgentTask) {
      tasks.push(task);
      const reply = replies.shift() ?? { output: { title: "ok" } };
      if ("error" in reply) throw reply.error;
      return { output: reply.output, costCents: 10, inputTokens: 300, outputTokens: 100, turns: 1 };
    },
  };
  const s = {
    ctx: {},
    job: { id: "job_1", payload: {}, budgetCents, spentCents: 0 },
    attempt: 1,
    input: { topic: "t" },
    signal: new AbortController().signal,
    outputs: {},
    services: {},
    agents: {
      runtime,
      latestOverrun: async () => undefined,
      grantedOverruns: async () => 0,
      consumeOverrun: async () => {},
    },
  } as unknown as StageContext;
  return { s, tasks };
}

describe("agent stage repair turn", () => {
  it("runs the repair under what the first run left of the stage limits", async () => {
    const { s, tasks } = setup([{ output: { title: "far too long" } }, { output: { title: "short" } }]);
    const result = await stage.run(s);
    expect(result.output).toEqual({ title: "short" });
    expect(tasks).toHaveLength(2);
    const [first, second] = tasks as [AgentTask, AgentTask];
    expect(first.willRepair).toBe(true);
    expect(second.input.repair).toMatchObject({ issues: [expect.objectContaining({ path: "title" })] });
    expect(second.maxCostCents).toBe(limits.maxCostCents - 10);
    expect(second.maxTurns).toBe(limits.maxTurns - 1);
    expect(second.maxTokens).toBe(limits.maxTokens - 400);
    expect(second.deadlineAt?.getTime()).toBe(first.deadlineAt?.getTime());
    expect(second.willRepair).toBeUndefined();
    expect(result.usage).toHaveLength(2);
  });

  it("caps the repair at the job budget left", async () => {
    const { s, tasks } = setup([{ output: { title: "far too long" } }], 15);
    await stage.run(s);
    expect(tasks[1]?.maxCostCents).toBe(5);
  });

  it("gives a caller's own repair turn no second one", async () => {
    const { s, tasks } = setup([{ output: { title: "far too long" } }]);
    await expect(stage.run({ ...s, input: { repair: { issues: [] } } })).rejects.toThrow(/fails its schema/);
    expect(tasks).toHaveLength(1);
  });

  it("parks for an overrun when the repair turn reaches a cap", async () => {
    const error = new StudixError("BUDGET_EXCEEDED", "turn cap", {
      details: { cap: "turns", spent: { costCents: 3, inputTokens: 1, outputTokens: 1, turns: 3 } },
    });
    const { s } = setup([{ output: { title: "far too long" } }, { error }]);
    await expect(stage.run(s)).rejects.toBeInstanceOf(StageSuspended);
  });
});
