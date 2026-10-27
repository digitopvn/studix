import { isStudixError, type Logger, type StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { failureReason } from "../decision-errors.ts";
import type { DecisionFailureReason, DecisionProvider } from "../decision-types.ts";
import {
  CONTRACT_INVALID_OUTPUT,
  CONTRACT_VALID_OUTPUT,
  captureLogger,
  contractRequest,
} from "./contract-fixtures.ts";

/**
 * How the provider's upstream should behave for one contract case. Factories script their transport
 * (mocked fetch, rule functions, fake steps) to produce the equivalent behavior.
 */
export type ContractScenario =
  /** Answer with CONTRACT_VALID_OUTPUT. */
  | "valid"
  /** Answer with CONTRACT_INVALID_OUTPUT (or the protocol's equivalent). */
  | "invalid"
  /** Answer only after ~10s unless aborted. */
  | "slow"
  /** Upstream rate limit (HTTP 429 or equivalent). */
  | "rate_limited"
  /** Upstream outage (HTTP 5xx / network or equivalent). */
  | "unavailable"
  /** Credentials rejected (HTTP 401 or equivalent). */
  | "auth_failed"
  /** Upstream failure whose message/body echoes `secret`. */
  | "leaky_error"
  /** Valid answer, but the provider is configured with a nonzero pre-call cost estimate. */
  | "costly";

export interface ContractSubject {
  provider: DecisionProvider;
  /** Calls that reached the upstream (network, rule function, scripted step). */
  upstreamCalls(): number;
  /** A credential the provider holds; must never appear in errors or logs. */
  secret: string;
  /** True for providers that never cost money (rules); budget refusal then cannot apply. */
  free?: boolean;
}

export type ContractFactory = (scenario: ContractScenario, context: { logger: Logger }) => ContractSubject;

async function rejection(promise: Promise<unknown>): Promise<StudixError> {
  try {
    await promise;
  } catch (error) {
    expect(isStudixError(error)).toBe(true);
    return error as StudixError;
  }
  throw new Error("expected the decision to be rejected");
}

function expectFailure(error: StudixError, code: string, reason: DecisionFailureReason, retryable: boolean) {
  expect(error.code).toBe(code);
  expect(failureReason(error)).toBe(reason);
  expect(error.retryable).toBe(retryable);
}

/** Shared behavioral contract every DecisionProvider adapter must pass. */
export function runDecisionProviderContract(name: string, factory: ContractFactory): void {
  describe(`DecisionProvider contract: ${name}`, () => {
    const setup = (scenario: ContractScenario) => {
      const { logger, lines } = captureLogger();
      return { ...factory(scenario, { logger }), lines };
    };

    it("returns a schema-validated, typed result with provenance", async () => {
      const { provider } = setup("valid");
      const request = contractRequest();
      const result = await provider.decide(request);
      expect(result.output).toEqual(CONTRACT_VALID_OUTPUT);
      expect(result.schemaValid).toBe(true);
      expect(result.providerId).toBe(provider.id);
      expect(result.model).toEqual(expect.any(String));
      expect(result.traceId).toBe(request.idempotencyKey);
      expect(result.attempts).toBe(1);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.costCents).toBeGreaterThanOrEqual(0);
      expect(result.costCents).toBeLessThanOrEqual(request.budgetCents);
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
    });

    it("rejects schema-invalid output without leaking it", async () => {
      const { provider } = setup("invalid");
      const error = await rejection(provider.decide(contractRequest()));
      expectFailure(error, "PROVIDER_ERROR", "schema_invalid", true);
      expect(JSON.stringify(error.toJSON())).not.toContain(CONTRACT_INVALID_OUTPUT.route);
    });

    it("rejects an invalid request before calling upstream", async () => {
      const subject = setup("valid");
      const error = await rejection(subject.provider.decide(contractRequest({ budgetCents: -1 })));
      expect(error.code).toBe("VALIDATION");
      expect(error.retryable).toBe(false);
      expect(subject.upstreamCalls()).toBe(0);
    });

    it("honors the timeout", async () => {
      const { provider } = setup("slow");
      const started = Date.now();
      const error = await rejection(provider.decide(contractRequest({ timeoutMs: 50 })));
      expectFailure(error, "TIMEOUT", "timeout", true);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("honors caller abort mid-flight", async () => {
      const { provider } = setup("slow");
      const controller = new AbortController();
      const pending = provider.decide(contractRequest({ signal: controller.signal }));
      setTimeout(() => controller.abort(), 20);
      const error = await rejection(pending);
      expectFailure(error, "CANCELLED", "cancelled", false);
    });

    it("does not call upstream when already aborted", async () => {
      const subject = setup("valid");
      const controller = new AbortController();
      controller.abort();
      const error = await rejection(subject.provider.decide(contractRequest({ signal: controller.signal })));
      expectFailure(error, "CANCELLED", "cancelled", false);
      expect(subject.upstreamCalls()).toBe(0);
    });

    it("enforces the budget before spending", async () => {
      const subject = setup("costly");
      const request = contractRequest({ budgetCents: 0 });
      if (subject.free) {
        expect(subject.provider.estimateCostCents(request)).toBe(0);
        const result = await subject.provider.decide(request);
        expect(result.costCents).toBe(0);
        return;
      }
      expect(subject.provider.estimateCostCents(request)).toBeGreaterThan(0);
      const error = await rejection(subject.provider.decide(request));
      expectFailure(error, "BUDGET_EXCEEDED", "budget_exceeded", false);
      expect(subject.upstreamCalls()).toBe(0);
    });

    it.each([
      ["rate_limited", "RATE_LIMITED", "rate_limited", true],
      ["unavailable", "UNAVAILABLE", "unavailable", true],
      ["auth_failed", "PROVIDER_ERROR", "auth", false],
    ] as const)("maps upstream %s to %s", async (scenario, code, reason, retryable) => {
      const { provider } = setup(scenario);
      const error = await rejection(provider.decide(contractRequest()));
      expectFailure(error, code, reason, retryable);
    });

    it("never leaks the provider secret in errors or logs", async () => {
      const { provider, secret, lines } = setup("leaky_error");
      const error = await rejection(provider.decide(contractRequest()));
      const surfaces = [error.message, error.stack ?? "", JSON.stringify(error.toJSON()), ...lines];
      expect(lines.length).toBeGreaterThan(0);
      for (const surface of surfaces) expect(surface).not.toContain(secret);
    });
  });
}
