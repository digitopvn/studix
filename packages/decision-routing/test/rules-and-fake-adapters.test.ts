import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { type DecisionRule, FakeDecisionAdapter, type FakeDecisionStep, RulesAdapter } from "../src/index.ts";
import {
  CONTRACT_INVALID_OUTPUT,
  CONTRACT_KIND,
  CONTRACT_VALID_OUTPUT,
  type ContractScenario,
  contractRequest,
  runDecisionProviderContract,
} from "../src/testing/index.ts";

/** Shaped like an OpenRouter key so the pattern-based redactor (not value registration) must catch it. */
const PATTERN_SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const failures: Partial<Record<ContractScenario, () => unknown>> = {
  rate_limited: () => new StudixError("RATE_LIMITED", "lookup service throttled"),
  unavailable: () => new StudixError("UNAVAILABLE", "lookup service down"),
  auth_failed: () =>
    new StudixError("PROVIDER_ERROR", "lookup credentials rejected", {
      retryable: false,
      details: { reason: "auth" },
    }),
  leaky_error: () => new Error(`lookup failed for Authorization: Bearer ${PATTERN_SECRET}`),
};

runDecisionProviderContract("RulesAdapter", (scenario, { logger }) => {
  let calls = 0;
  const rule: DecisionRule = async (_input, { signal }) => {
    calls += 1;
    if (scenario === "slow") await wait(10_000, signal);
    const failure = failures[scenario];
    if (failure) throw failure();
    return scenario === "invalid" ? CONTRACT_INVALID_OUTPUT : CONTRACT_VALID_OUTPUT;
  };
  return {
    provider: new RulesAdapter({ logger, rules: { [CONTRACT_KIND]: rule } }),
    upstreamCalls: () => calls,
    secret: PATTERN_SECRET,
    free: true,
  };
});

runDecisionProviderContract("FakeDecisionAdapter", (scenario, { logger }) => {
  const failure = failures[scenario];
  const step: FakeDecisionStep = failure
    ? { error: failure() }
    : scenario === "slow"
      ? { output: CONTRACT_VALID_OUTPUT, delayMs: 10_000 }
      : { output: scenario === "invalid" ? CONTRACT_INVALID_OUTPUT : CONTRACT_VALID_OUTPUT, costCents: 0.5 };
  const provider = new FakeDecisionAdapter({
    logger,
    steps: [step],
    estimateCostCents: scenario === "costly" ? 1 : 0,
  });
  return { provider, upstreamCalls: () => provider.invocations.length, secret: PATTERN_SECRET };
});

describe("RulesAdapter", () => {
  it("refuses kinds without a registered rule and forbids silent overrides", async () => {
    const rules = new RulesAdapter();
    await expect(rules.decide(contractRequest())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: false,
      details: { reason: "unsupported" },
    });
    rules.register(CONTRACT_KIND, () => CONTRACT_VALID_OUTPUT);
    expect(() => rules.register(CONTRACT_KIND, () => CONTRACT_VALID_OUTPUT)).toThrow(/already registered/);
    expect(rules.kinds()).toEqual([CONTRACT_KIND]);
  });

  it("does not JSON-parse string outputs from rules", async () => {
    const { z } = await import("zod");
    const rules = new RulesAdapter({ rules: { "copy.pick": () => "42" } });
    const result = await rules.decide({
      ...contractRequest(),
      kind: "copy.pick",
      schema: z.string(),
    } as never);
    expect((result as { output: unknown }).output).toBe("42");
  });

  it("honors the deadline even when a rule ignores its signal", async () => {
    const rules = new RulesAdapter({
      rules: {
        [CONTRACT_KIND]: () =>
          new Promise((resolve) => setTimeout(() => resolve(CONTRACT_VALID_OUTPUT), 1_000).unref()),
      },
    });
    await expect(rules.decide(contractRequest({ timeoutMs: 30 }))).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("FakeDecisionAdapter", () => {
  it("replays the script in order, then the fallback, then fails loudly", async () => {
    const fake = new FakeDecisionAdapter({
      steps: [{ output: { route: "review", urgent: false } }],
      fallback: { output: CONTRACT_VALID_OUTPUT },
    });
    expect((await fake.decide(contractRequest())).output).toEqual({ route: "review", urgent: false });
    expect((await fake.decide(contractRequest())).output).toEqual(CONTRACT_VALID_OUTPUT);
    expect(fake.calls).toHaveLength(2);

    const empty = new FakeDecisionAdapter();
    await expect(empty.decide(contractRequest())).rejects.toThrow(/script is exhausted/);
  });
});
