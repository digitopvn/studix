import type { AgentRuntime, TenantContext } from "@studix/core";
import { StudixError, type StudixErrorPayload, toStudixError } from "@studix/shared";
import { agentCapOf } from "./bounded-agent-runtime.ts";
import { createPiSdkAgentRuntime } from "./pi-agent-runtime.ts";
import type { PiRunBinding } from "./pi-binding.ts";
import { cheapestPiModel, isRuntimeKeyProvider } from "./pi-catalog.ts";

/** Same shape as `ProviderKeyTestResult` in @studix/auth (kept structural to avoid a package cycle). */
export interface PiKeyTestResult {
  ok: boolean;
  at: Date;
  latencyMs: number;
  verdict: "available" | "invalid" | "unverified";
  error?: StudixErrorPayload;
}

export interface PiKeyTesterOptions {
  /** Test seam: runs the probe binding. Production builds a Pi SDK runtime for it. */
  runtimeFor?: (binding: PiRunBinding) => AgentRuntime;
  timeoutMs?: number;
  now?: () => Date;
}

/** Most providers have no free authenticated endpoint, so the test is one tiny prompt, capped at 1 cent. */
const PROBE_COST_CAP_CENTS = 1;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The probe reads no tenant data: the static binding carries the only credential, so the context is a
 * fixed system actor that never reaches a repository.
 */
const PROBE_CONTEXT: TenantContext = {
  organizationId: "provider-key-test",
  workspaceId: "provider-key-test",
  actor: { type: "system", id: "provider-key-test" },
};

function payload(error: StudixError): StudixErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}),
  };
}

/**
 * Tests a non-Anthropic key by asking the provider's cheapest catalog model for one word through the Pi
 * SDK. A run that stops only at the one-cent cap still proves the provider accepted the key.
 */
export function createPiKeyTester(options: PiKeyTesterOptions = {}) {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runtimeFor =
    options.runtimeFor ??
    ((binding: PiRunBinding) =>
      createPiSdkAgentRuntime({ resolver: { resolve: async () => ({ bindings: [binding] }) } }));
  return {
    async test(apiKey: string, provider: string): Promise<PiKeyTestResult> {
      const started = Date.now();
      const done = (verdict: PiKeyTestResult["verdict"], error?: StudixError): PiKeyTestResult => ({
        ok: verdict === "available",
        at: now(),
        latencyMs: Date.now() - started,
        verdict,
        ...(error ? { error: payload(error) } : {}),
      });
      const model = isRuntimeKeyProvider(provider) ? cheapestPiModel(provider) : undefined;
      if (!model) {
        return done(
          "unverified",
          new StudixError("UNAVAILABLE", `No ${provider} model is available to test the key`, {
            retryable: false,
          }),
        );
      }
      try {
        await runtimeFor({ provider, modelId: model.id, apiKey, connectionId: "key-test" }).run(
          PROBE_CONTEXT,
          {
            skill: "connection-test",
            instructions: "Reply with the single word OK.",
            input: {},
            maxTurns: 1,
            maxCostCents: PROBE_COST_CAP_CENTS,
            deadlineAt: new Date(Date.now() + timeoutMs),
          },
        );
        return done("available");
      } catch (err) {
        const error = toStudixError(err, "PROVIDER_ERROR");
        if (agentCapOf(error) === "cost") return done("available");
        if (error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN") return done("invalid", error);
        return done("unverified", error);
      }
    },
  };
}
