import { createInMemoryActivityRepository, testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { purgeExpiredActivity } from "../src/activity-retention.ts";

const DAY = 24 * 3600 * 1000;

function clockAt(start: number) {
  let t = start;
  return { clock: { now: () => new Date(t) }, set: (v: number) => (t = v) };
}

describe("activity retention sweep", () => {
  it("removes runtime events older than 7 days in every workspace and keeps the rest", async () => {
    const now = Date.parse("2026-11-08T00:00:00Z");
    const time = clockAt(now - 8 * DAY);
    const repo = createInMemoryActivityRepository(time.clock);
    const a = testTenant({ workspaceId: "ws_a" });
    const b = testTenant({ workspaceId: "ws_b" });
    await repo.append(a, { name: "job.failed", level: "error", attributes: {} });
    await repo.append(b, { name: "api.request", level: "debug", attributes: {} });
    // The job chat is a record users read back, so it outlives the window.
    await repo.append(a, { name: "agent.event", level: "info", attributes: { type: "message" } });
    time.set(now - 6 * DAY);
    await repo.append(a, { name: "job.done", level: "info", attributes: {} });

    expect(await purgeExpiredActivity(repo, new Date(now))).toBe(2);
    const left = (await repo.window(a, { from: new Date(0), to: new Date(now), limit: 100 })).map(
      (e) => e.name,
    );
    expect(left.sort()).toEqual(["agent.event", "job.done"]);
    expect(await repo.window(b, { from: new Date(0), to: new Date(now), limit: 100 })).toHaveLength(0);
    expect(await purgeExpiredActivity(repo, new Date(now))).toBe(0);
  });
});
