import { describe, expect, it } from "vitest";
import { createManualClock, systemClock } from "../src/index.ts";

describe("clocks", () => {
  it("manual clock only moves when told to", () => {
    const clock = createManualClock(new Date("2026-01-01T00:00:00Z"));
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    clock.set(0);
    expect(clock.now().getTime()).toBe(0);
  });

  it("system clock returns current time", () => {
    const before = Date.now();
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(before);
  });
});
