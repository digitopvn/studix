import { isRetryableAssistantError, retryDelayMs } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PI_TURN_RETRY } from "../src/index.ts";

const failed = (errorMessage: string) => ({ stopReason: "error", errorMessage }) as never;

describe("Pi turn retry", () => {
  it("retries a provider rate limit or overload, not a bad key or an empty quota", () => {
    expect(isRetryableAssistantError(failed("429 [prefill_cap_refused] retry shortly (after 30 s)"))).toBe(
      true,
    );
    expect(isRetryableAssistantError(failed("503 overloaded"))).toBe(true);
    expect(isRetryableAssistantError(failed("401 invalid key"))).toBe(false);
    expect(isRetryableAssistantError(failed("insufficient_quota"))).toBe(false);
  });

  it("waits at least a 30 s retry-after within about four minutes in total", () => {
    const delays = Array.from({ length: PI_TURN_RETRY.maxRetries }, (_, i) =>
      retryDelayMs(PI_TURN_RETRY, i + 1),
    );
    expect(delays.slice(1).every((d) => d >= 30_000)).toBe(true);
    expect(delays.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4 * 60_000);
  });
});
