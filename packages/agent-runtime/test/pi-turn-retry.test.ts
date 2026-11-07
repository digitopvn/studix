import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { jitteredRetry, mapProviderFailure, PI_TURN_RETRY, type PiRunBinding } from "../src/index.ts";

const failed = (errorMessage: string) => ({ stopReason: "error", errorMessage }) as never;
const binding = { provider: "opencode-go", modelId: "glm-5.3", apiKey: "sk-x" } as PiRunBinding;

describe("Pi turn retry", () => {
  it("backs off on an overload for about 10 minutes, each wait at most 2, but fails a quota at once", () => {
    const overloaded = "429 [overloaded] the server is overloaded";
    expect(isRetryableAssistantError(failed(overloaded))).toBe(true);
    expect(isRetryableAssistantError(failed("insufficient_quota"))).toBe(false);

    for (const random of [() => 0, () => 0.999]) {
      const policy = jitteredRetry(PI_TURN_RETRY, random);
      const delays = Array.from({ length: policy.maxRetries }, (_, i) => retryDelayMs(policy, i + 1));
      expect(Math.max(...delays)).toBeLessThanOrEqual(120_000);
      const total = delays.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(8 * 60_000);
      expect(total).toBeLessThan(11 * 60_000);
    }

    const error = mapProviderFailure(overloaded, binding, 9.5 * 60_000);
    expect(error).toMatchObject({ code: "PROVIDER_OVERLOADED", retryable: true });
    expect(error.message).toContain("opencode-go is overloaded; Studix retried for 10 min");
    expect(mapProviderFailure("429 insufficient_quota", binding)).toMatchObject({
      code: "RATE_LIMITED",
      retryable: false,
    });
  });
});
