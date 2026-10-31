import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import {
  type AgentLoop,
  agentCapOf,
  agentSpendOf,
  createBoundedAgentRuntime,
  createFakeAgentRuntime,
} from "../src/index.ts";

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "script",
  instructions: "Write a script",
  input: {},
  maxCostCents: 50,
  maxTurns: 4,
  maxTokens: 1000,
  ...overrides,
});

/** A loop that reports usage, then works until it is aborted and needs `cleanupMs` to stop. */
function workingLoop(report: Parameters<Parameters<AgentLoop>[1]["reportUsage"]>[0], cleanupMs = 20) {
  const state = { stopped: false, sawAbort: false };
  const loop: AgentLoop = (_ctx, t) =>
    new Promise((_, reject) => {
      t.signal.addEventListener("abort", () => {
        state.sawAbort = true;
        setTimeout(() => {
          state.stopped = true;
          reject(t.signal.reason);
        }, cleanupMs);
      });
      t.reportUsage(report);
    });
  return { loop, state };
}

describe("bounded agent runtime caps", () => {
  it.each([
    ["turns", { turns: 5, inputTokens: 0, outputTokens: 0, costCents: 0 }, "PROVIDER_ERROR"],
    ["tokens", { turns: 1, inputTokens: 900, outputTokens: 101, costCents: 0 }, "BUDGET_EXCEEDED"],
    ["cost", { turns: 1, inputTokens: 1, outputTokens: 1, costCents: 50.5 }, "BUDGET_EXCEEDED"],
  ] as const)(
    "stops the loop mid-run at the %s cap and waits until it has stopped",
    async (cap, usage, code) => {
      const { loop, state } = workingLoop(usage);
      const runtime = createBoundedAgentRuntime({ id: "t", loop });
      const err = await runtime.run(testTenant(), task()).catch((e: unknown) => e);
      expect(err).toMatchObject({ code, retryable: false });
      expect(agentCapOf(err)).toBe(cap);
      expect(state.sawAbort).toBe(true);
      // The run settled only after the loop finished stopping.
      expect(state.stopped).toBe(true);
    },
  );

  it("stops at the time cap and carries what was spent", async () => {
    const { loop, state } = workingLoop({ turns: 1, inputTokens: 10, outputTokens: 5, costCents: 2 });
    const runtime = createBoundedAgentRuntime({ id: "t", loop });
    const err = await runtime
      .run(testTenant(), task({ deadlineAt: new Date(Date.now() + 30) }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(agentCapOf(err)).toBe("time");
    expect(agentSpendOf(err)).toMatchObject({ costCents: 2, inputTokens: 10, outputTokens: 5 });
    expect(state.stopped).toBe(true);
  });

  it("reports INTERNAL when the loop does not stop after the abort", async () => {
    const runtime = createBoundedAgentRuntime({
      id: "t",
      stopGraceMs: 30,
      loop: async () => new Promise(() => {}),
    });
    const err = await runtime
      .run(testTenant(), task({ deadlineAt: new Date(Date.now() + 20) }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INTERNAL", details: { stopCode: "TIMEOUT", cap: "time" } });
  });

  it("rejects a result over the token cap even without mid-run reports", async () => {
    const runtime = createFakeAgentRuntime(() => ({ output: "x", inputTokens: 600, outputTokens: 600 }));
    const err = await runtime.run(testTenant(), task()).catch((e: unknown) => e);
    expect(agentCapOf(err)).toBe("tokens");
    expect(agentSpendOf(err)).toMatchObject({ inputTokens: 600, outputTokens: 600 });
  });

  it("is not a cap stop when the caller cancels", async () => {
    const controller = new AbortController();
    const runtime = createFakeAgentRuntime(() => new Promise(() => {}));
    const running = runtime.run(testTenant(), task({ signal: controller.signal }));
    controller.abort();
    const err = await running.catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CANCELLED" });
    expect(agentCapOf(err)).toBeUndefined();
  });

  it("rejects an invalid token cap and redacts secrets from the output", async () => {
    const runtime = createFakeAgentRuntime(() => ({
      output: { script: "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz to call" },
    }));
    await expect(runtime.run(testTenant(), task({ maxTokens: 0 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const result = await runtime.run(testTenant(), task());
    expect(JSON.stringify(result.output)).not.toContain("sk-ant-api03");
    expect(result.output).toEqual({ script: "use key [redacted] to call" });
  });
});
