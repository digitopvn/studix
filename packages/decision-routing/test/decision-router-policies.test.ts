import { testTenant } from "@studix/core/testing";
import { describe, expect, it, vi } from "vitest";
import { DecisionRouter, FakeDecisionAdapter, RulesAdapter } from "../src/index.ts";
import { SINK_TIMEOUT_MS } from "../src/router/provider-execution-sink.ts";
import { CONTRACT_KIND, CONTRACT_VALID_OUTPUT, contractRequest } from "../src/testing/index.ts";
import { useInMemoryTracing } from "./otel-in-memory-tracing.ts";
import { testRouter, unavailable } from "./router-test-helpers.ts";

const exporter = useInMemoryTracing();
const valid = () =>
  new FakeDecisionAdapter({ id: "fake", fallback: { output: CONTRACT_VALID_OUTPUT, costCents: 1 } });

describe("DecisionRouter idempotency", () => {
  it("replays a completed decision for the same key without calling providers again", async () => {
    const fake = valid();
    const { router } = testRouter([fake]);
    const request = contractRequest();
    const first = await router.decide(request);
    const second = await router.decide({ ...request });
    expect(second).toMatchObject({ output: first.output, providerId: first.providerId, replayed: true });
    expect(first.replayed).toBeUndefined();
    expect(fake.invocations).toHaveLength(1);
  });

  it("marks replays as free and drops their execution link so the bill is not counted twice", async () => {
    const { router } = testRouter([valid()]);
    const request = contractRequest();
    const first = await router.decide(request);
    const second = await router.decide({ ...request });
    expect(first.costCents).toBeGreaterThan(0);
    expect(second.costCents).toBe(0);
    expect(second.providerExecutionId).toBeUndefined();
  });

  it("shares one in-flight call between concurrent callers", async () => {
    const fake = new FakeDecisionAdapter({
      id: "fake",
      fallback: { output: CONTRACT_VALID_OUTPUT, delayMs: 20 },
    });
    const { router } = testRouter([fake]);
    const request = contractRequest();
    const [a, b] = await Promise.all([router.decide(request), router.decide({ ...request })]);
    expect(a.output).toEqual(b.output);
    expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
    expect(fake.invocations).toHaveLength(1);
  });

  it("scopes keys per workspace, rejects reuse with a different input, and does not cache failures", async () => {
    const fake = new FakeDecisionAdapter({ id: "fake", steps: [{ error: unavailable() }] });
    fake.enqueue({ error: unavailable() });
    const { router } = testRouter([fake], { maxAttemptsPerProvider: 2 });
    const request = contractRequest();
    await expect(router.decide(request)).rejects.toMatchObject({ code: "UNAVAILABLE" });

    fake.enqueue({ output: CONTRACT_VALID_OUTPUT }, { output: CONTRACT_VALID_OUTPUT });
    await expect(router.decide(request)).resolves.toMatchObject({ providerId: "fake" });
    await expect(router.decide({ ...request, input: { other: true } })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await router.decide({ ...request, tenant: testTenant() });
    expect(fake.invocations).toHaveLength(4);
  });

  it("expires replayed results after the TTL", async () => {
    const fake = valid();
    const { router, clock } = testRouter([fake], { idempotency: { ttlMs: 1_000 } });
    const request = contractRequest();
    await router.decide(request);
    clock.advance(1_001);
    await router.decide(request);
    expect(fake.invocations).toHaveLength(2);
  });
});

describe("DecisionRouter deadlines", () => {
  it("stops the whole chain with TIMEOUT once the total deadline passes", async () => {
    const slow = new FakeDecisionAdapter({
      id: "slow",
      fallback: { output: CONTRACT_VALID_OUTPUT, delayMs: 5_000 },
    });
    const backup = valid();
    const { router, records } = testRouter([slow, backup]);
    await expect(router.decide(contractRequest({ timeoutMs: 40 }))).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(backup.calls).toHaveLength(0);
    expect(records[0]?.execution.status).toBe("timeout");
  });

  it("propagates caller cancellation without falling back", async () => {
    const slow = new FakeDecisionAdapter({
      id: "slow",
      fallback: { output: CONTRACT_VALID_OUTPUT, delayMs: 5_000 },
    });
    const backup = valid();
    const { router } = testRouter([slow, backup]);
    const controller = new AbortController();
    const pending = router.decide(contractRequest({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 15);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", retryable: false });
    expect(backup.calls).toHaveLength(0);
  });

  it("rejects invalid requests before touching any provider", async () => {
    const fake = valid();
    const { router } = testRouter([fake]);
    await expect(router.decide(contractRequest({ timeoutMs: 0 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(router.decide(contractRequest({ kind: "Not A Kind" }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("DecisionRouter fail-closed policy", () => {
  it("refuses to configure a rules fallback for security, cost, publish or approval decisions", () => {
    const rules = new RulesAdapter();
    expect(
      () =>
        new DecisionRouter({ providers: [valid(), rules], routes: { "publish.approve": ["fake", "rules"] } }),
    ).toThrow(/fail-closed/);
  });

  it("drops rules from the default chain for fail-closed kinds and denies when models fail", async () => {
    const model = new FakeDecisionAdapter({ id: "model", fallback: { error: unavailable() } });
    const rules = new RulesAdapter({
      rules: { "approval.grant": () => CONTRACT_VALID_OUTPUT, [CONTRACT_KIND]: () => CONTRACT_VALID_OUTPUT },
    });
    const { router } = testRouter([model, rules], { maxAttemptsPerProvider: 1 });
    await expect(router.decide(contractRequest({ kind: "approval.grant" }))).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    // The same default chain still falls back to rules for kinds that allow a deterministic answer.
    await expect(router.decide(contractRequest())).resolves.toMatchObject({ providerId: "rules" });
  });

  it("rejects unknown providers in routes and unrouted kinds", async () => {
    expect(() => new DecisionRouter({ providers: [valid()], routes: { "qa.route": ["nope"] } })).toThrow(
      /unknown provider/,
    );
    const router = new DecisionRouter({ providers: [valid()], routes: { "qa.route": ["fake"] } });
    await expect(router.decide(contractRequest({ kind: "video.plan" }))).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});

describe("DecisionRouter circuit breaker", () => {
  it("skips a provider after consecutive failures and retries it after the cooldown", async () => {
    const flaky = new FakeDecisionAdapter({ id: "flaky", fallback: { error: unavailable() } });
    const backup = new FakeDecisionAdapter({ id: "backup", fallback: { output: CONTRACT_VALID_OUTPUT } });
    const { router, clock } = testRouter([flaky, backup], {
      maxAttemptsPerProvider: 1,
      circuitBreaker: { failureThreshold: 2, cooldownMs: 10_000 },
      idempotency: false,
    });
    await router.decide(contractRequest());
    await router.decide(contractRequest());
    const skipped = await router.decide(contractRequest());
    expect(skipped.fallbackChain[0]).toMatchObject({
      providerId: "flaky",
      outcome: "skipped",
      reason: "circuit_open",
    });
    expect(flaky.invocations).toHaveLength(2);
    clock.advance(10_001);
    await router.decide(contractRequest());
    expect(flaky.invocations).toHaveLength(3);
  });
});

describe("DecisionRouter telemetry", () => {
  it("emits a decision span with provider, model, cost and fallback, plus one span per attempt", async () => {
    const failing = new FakeDecisionAdapter({ id: "failing", fallback: { error: unavailable() } });
    const ok = new FakeDecisionAdapter({
      id: "ok",
      model: "m-1",
      fallback: { output: CONTRACT_VALID_OUTPUT, costCents: 2 },
    });
    const { router } = testRouter([failing, ok], { maxAttemptsPerProvider: 1 });
    const request = contractRequest({ jobId: "job_9" });
    await router.decide(request);
    const spans = exporter.getFinishedSpans();
    const decision = spans.find((s) => s.name === "decision.decide");
    expect(decision?.attributes).toMatchObject({
      "studix.decision.kind": CONTRACT_KIND,
      "studix.decision.trace_id": request.idempotencyKey,
      "studix.provider": "ok",
      "studix.model": "m-1",
      "studix.job.id": "job_9",
      "studix.workspace.id": request.tenant.workspaceId,
      "studix.decision.cost_cents": 2,
      "studix.decision.attempts": 2,
      "studix.decision.fallback_reason": "unavailable",
    });
    expect(
      spans.filter((s) => s.name === "decision.provider_call").map((s) => s.attributes["studix.provider"]),
    ).toEqual(["failing", "ok"]);
  });

  it("keeps deciding when the execution sink throws", async () => {
    const router = new DecisionRouter({
      providers: [valid()],
      defaultRoute: ["fake"],
      sink: {
        record: () => {
          throw new Error("db down");
        },
      },
    });
    const result = await router.decide(contractRequest());
    expect(result.providerId).toBe("fake");
    // Nothing was stored, so nothing may be linked from usage events.
    expect(result.providerExecutionId).toBeUndefined();
    expect(result.fallbackChain[0]?.executionId).toBeUndefined();
  });
});

describe("provider execution sink on the critical path", () => {
  it("does not let a hung sink hold the decision or link a missing execution", async () => {
    vi.useFakeTimers();
    try {
      const hung = { record: () => new Promise<void>(() => {}) };
      const { router } = testRouter([valid()], { sink: hung });
      const pending = router.decide(contractRequest());
      await vi.advanceTimersByTimeAsync(SINK_TIMEOUT_MS + 1);
      const result = await pending;
      expect(result.providerExecutionId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
