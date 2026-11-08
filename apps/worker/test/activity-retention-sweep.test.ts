import type { ActivityPurgeOptions, ActivityRetention } from "@studix/core";
import { LOG_RETENTION_MS } from "@studix/observability";
import { createLogger } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { RETAINED_ACTIVITY_NAMES, sweepActivityEvents } from "../src/activity-retention-sweep.ts";

describe("sweepActivityEvents", () => {
  it("purges runtime events older than the log window and keeps the chat transcript", async () => {
    const calls: Array<{ before: Date; options: ActivityPurgeOptions }> = [];
    const retention: ActivityRetention = {
      async purgeBefore(before, options) {
        calls.push({ before, options });
        return 3;
      },
    };
    const now = new Date("2026-11-08T12:00:00.000Z");
    const logger = createLogger({}, { write: () => {} });
    expect(await sweepActivityEvents(retention, logger, now)).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.before.getTime()).toBe(now.getTime() - LOG_RETENTION_MS);
    expect(calls[0]?.options.keepNames).toEqual(["agent.event"]);
    expect(RETAINED_ACTIVITY_NAMES).toContain("agent.event");
  });
});
