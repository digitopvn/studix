import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { createFakeAgentRuntime, createPiAgentRuntime } from "../src/index.ts";

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "brand-intro",
  instructions: "Plan a 15s intro",
  input: { prompt: "coffee" },
  maxCostCents: 50,
  maxTurns: 4,
  ...overrides,
});

describe("fake agent runtime", () => {
  it("returns scripted output and records calls", async () => {
    const runtime = createFakeAgentRuntime(() => ({ output: { ok: true }, costCents: 3, turns: 2 }));
    const result = await runtime.run(testTenant(), task());
    expect(result).toMatchObject({ output: { ok: true }, costCents: 3, turns: 2, model: "fake-model" });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.task.skill).toBe("brand-intro");
  });

  it("enforces cost and turn limits on the reply", async () => {
    const pricey = createFakeAgentRuntime(() => ({ output: null, costCents: 51 }));
    await expect(pricey.run(testTenant(), task())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    const chatty = createFakeAgentRuntime(() => ({ output: null, turns: 5 }));
    await expect(chatty.run(testTenant(), task())).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("rejects invalid tasks and passed deadlines before running the loop", async () => {
    const runtime = createFakeAgentRuntime(() => ({ output: null }));
    await expect(runtime.run(testTenant(), task({ maxTurns: 0 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() - 1) })),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(runtime.calls).toHaveLength(0);
  });

  it("stops a stuck loop on caller abort and on deadline", async () => {
    const stuck = createFakeAgentRuntime(() => new Promise(() => {}));
    const controller = new AbortController();
    const running = stuck.run(testTenant(), task({ signal: controller.signal }));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      stuck.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 30) })),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("pi agent runtime", () => {
  it("is honest that no loop is configured in P0", async () => {
    const runtime = createPiAgentRuntime();
    expect(runtime.id).toBe("pi");
    await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("runs an injected loop inside the limits", async () => {
    const runtime = createPiAgentRuntime({
      loop: async () => ({ output: "plan", turns: 1, costCents: 1, inputTokens: 10, outputTokens: 5 }),
    });
    await expect(runtime.run(testTenant(), task())).resolves.toMatchObject({ output: "plan" });
  });
});
