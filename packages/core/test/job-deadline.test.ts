import { describe, expect, it } from "vitest";
import { deadlineAfterWait } from "../src/index.ts";

describe("deadlineAfterWait", () => {
  const parkedAt = new Date("2026-01-01T10:00:00Z");
  const deadlineAt = new Date("2026-01-01T10:30:00Z");

  it("moves the deadline out by the time spent waiting", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(deadlineAfterWait({ deadlineAt, updatedAt: parkedAt }, now)).toEqual(
      new Date("2026-01-01T12:30:00Z"),
    );
  });

  it("leaves a job without a deadline unbounded", () => {
    expect(deadlineAfterWait({ updatedAt: parkedAt }, new Date("2026-01-01T12:00:00Z"))).toBeUndefined();
  });

  it("never moves the deadline earlier when the clock reads before the park time", () => {
    expect(deadlineAfterWait({ deadlineAt, updatedAt: parkedAt }, new Date("2026-01-01T09:00:00Z"))).toEqual(
      deadlineAt,
    );
  });
});
