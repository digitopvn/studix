import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { FakeDecisionAdapter, RulesAdapter } from "../src/index.ts";
import {
  CONTRACT_INVALID_OUTPUT,
  CONTRACT_KIND,
  CONTRACT_VALID_OUTPUT,
  contractRequest,
} from "../src/testing/index.ts";
import { authFailed, rateLimited, testRouter, unavailable } from "./router-test-helpers.ts";

describe("DecisionRouter fallback order", () => {
  it("walks the chain in order, retrying retryable failures, until one provider yields a valid decision", async () => {
    const typesafe = new FakeDecisionAdapter({
      id: "typesafe",
      steps: [{ error: unavailable() }, { error: unavailable() }],
    });
    const openrouter = new FakeDecisionAdapter({
      id: "openrouter",
      steps: [
        { output: CONTRACT_INVALID_OUTPUT, costCents: 0.2, usage: { inputTokens: 100, outputTokens: 10 } },
        { output: CONTRACT_INVALID_OUTPUT, costCents: 0.2, usage: { inputTokens: 100, outputTokens: 10 } },
      ],
    });
    const rules = new RulesAdapter({ rules: { [CONTRACT_KIND]: () => CONTRACT_VALID_OUTPUT } });
    const { router, records, sleeps } = testRouter([typesafe, openrouter, rules]);
    const request = contractRequest({ jobId: "job_1", stageId: "plan" });

    const result = await router.decide(request);

    expect(result.output).toEqual(CONTRACT_VALID_OUTPUT);
    expect(result.providerId).toBe("rules");
    expect(result.model).toBe("rules");
    expect(result.attempts).toBe(5);
    expect(result.fallbackReason).toBe("unavailable");
    expect(result.costCents).toBeCloseTo(0.4, 10);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(result.traceId).toBe(request.idempotencyKey);
    expect(result.fallbackChain.map((s) => [s.providerId, s.attempt, s.outcome, s.reason])).toEqual([
      ["typesafe", 1, "failed", "unavailable"],
      ["typesafe", 2, "failed", "unavailable"],
      ["openrouter", 1, "failed", "schema_invalid"],
      ["openrouter", 2, "failed", "schema_invalid"],
      ["rules", 1, "succeeded", undefined],
    ]);
    expect(sleeps).toEqual([250, 250]);

    expect(records).toHaveLength(5);
    expect(records.every((r) => r.ctx === request.tenant)).toBe(true);
    expect(records[2]?.execution).toMatchObject({
      jobId: "job_1",
      stageId: "plan",
      provider: "openrouter",
      model: "fake-model",
      operation: "decision.qa.route",
      status: "failed",
      costCents: 0.2,
      inputTokens: 100,
      outputTokens: 10,
      attempt: 1,
      error: { code: "PROVIDER_ERROR" },
    });
    expect(records[4]?.execution).toMatchObject({
      provider: "rules",
      status: "succeeded",
      costCents: 0,
      attempt: 1,
    });
  });

  it("does not retry terminal errors and falls back immediately", async () => {
    const primary = new FakeDecisionAdapter({ id: "primary", steps: [{ error: authFailed() }] });
    const secondary = new FakeDecisionAdapter({
      id: "secondary",
      steps: [{ output: CONTRACT_VALID_OUTPUT }],
    });
    const { router, sleeps } = testRouter([primary, secondary]);
    const result = await router.decide(contractRequest());
    expect(primary.invocations).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(result).toMatchObject({ providerId: "secondary", attempts: 2, fallbackReason: "auth" });
  });

  it("retries a retryable failure on the same provider with exponential backoff and Retry-After hints", async () => {
    const hinted = new StudixError("RATE_LIMITED", "slow down", { details: { retryAfterMs: 1_200 } });
    const primary = new FakeDecisionAdapter({
      id: "primary",
      steps: [{ error: rateLimited() }, { error: hinted }, { output: CONTRACT_VALID_OUTPUT }],
    });
    const { router, sleeps } = testRouter([primary], { maxAttemptsPerProvider: 3 });
    const result = await router.decide(contractRequest());
    expect(result).toMatchObject({ providerId: "primary", attempts: 3 });
    expect(result.fallbackReason).toBeUndefined();
    expect(sleeps).toEqual([250, 1_200]);
  });

  it("fails closed with the last error when every provider fails", async () => {
    const a = new FakeDecisionAdapter({ id: "a", fallback: { error: unavailable() } });
    const b = new FakeDecisionAdapter({ id: "b", fallback: { error: authFailed() } });
    const { router } = testRouter([a, b]);
    await expect(router.decide(contractRequest())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: false,
      details: { reason: "auth", attempts: 3, kind: CONTRACT_KIND },
    });
  });
});

describe("DecisionRouter budget", () => {
  it("skips providers whose estimate exceeds the remaining budget", async () => {
    const pricey = new FakeDecisionAdapter({
      id: "pricey",
      estimateCostCents: 10,
      fallback: { output: CONTRACT_VALID_OUTPUT },
    });
    const cheap = new FakeDecisionAdapter({
      id: "cheap",
      estimateCostCents: 1,
      fallback: { output: CONTRACT_VALID_OUTPUT },
    });
    const { router, records } = testRouter([pricey, cheap]);
    const result = await router.decide(contractRequest({ budgetCents: 5 }));
    expect(pricey.calls).toHaveLength(0);
    expect(result.providerId).toBe("cheap");
    expect(result.fallbackChain[0]).toMatchObject({
      providerId: "pricey",
      outcome: "skipped",
      reason: "budget_exceeded",
    });
    expect(result.fallbackReason).toBe("budget_exceeded");
    expect(records).toHaveLength(1);
  });

  it("counts spend from failed attempts against the remaining budget", async () => {
    const wasteful = new FakeDecisionAdapter({
      id: "wasteful",
      estimateCostCents: 3,
      fallback: { output: CONTRACT_INVALID_OUTPUT, costCents: 3 },
    });
    const { router } = testRouter([wasteful]);
    const error = await router.decide(contractRequest({ budgetCents: 5 })).catch((e: unknown) => e);
    expect(wasteful.invocations).toHaveLength(1);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      details: { reason: "schema_invalid", costCents: 3 },
    });
  });

  it("refuses with BUDGET_EXCEEDED when no provider fits the budget", async () => {
    const pricey = new FakeDecisionAdapter({ id: "pricey", estimateCostCents: 10 });
    const { router } = testRouter([pricey]);
    await expect(router.decide(contractRequest({ budgetCents: 1 }))).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: false,
      details: { reason: "budget_exceeded", costCents: 0 },
    });
  });

  it("passes only the remaining budget down to each provider", async () => {
    const first = new FakeDecisionAdapter({
      id: "first",
      fallback: { output: CONTRACT_INVALID_OUTPUT, costCents: 2 },
    });
    const second = new FakeDecisionAdapter({
      id: "second",
      fallback: { output: CONTRACT_VALID_OUTPUT, costCents: 1 },
    });
    const { router } = testRouter([first, second], { maxAttemptsPerProvider: 1 });
    const result = await router.decide(contractRequest({ budgetCents: 5 }));
    expect(second.calls[0]?.budgetCents).toBe(3);
    expect(result.costCents).toBe(3);
  });
});
