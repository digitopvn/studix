import type { TenantContext } from "@studix/core";
import { createManualClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const clock = createManualClock(new Date());
const db = withTestDatabase({ clock });
const DAY = 86_400_000;

async function provision(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: slug, slug },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_owner", role: "owner" },
  };
}

describe("activity retention", () => {
  it("deletes old runtime events in every workspace and keeps recent ones and retained names", async () => {
    const a = await provision("ret-a");
    const b = await provision("ret-b");
    const { activity, activityRetention } = db.current.repos;
    for (const ctx of [a, b]) {
      await activity.append(ctx, { name: "job.created", level: "info", attributes: {} });
      await activity.append(ctx, { name: "agent.event", level: "info", attributes: { type: "status" } });
    }
    const cutoff = new Date(Date.now() + DAY);
    // Everything just written is older than the cutoff, so only the retained name survives.
    const removed = await activityRetention.purgeBefore(cutoff, { keepNames: ["agent.event"], batchSize: 1 });
    expect(removed).toBe(2);
    for (const ctx of [a, b]) {
      const left = await activity.window(ctx, {
        from: new Date(Date.now() - DAY),
        to: cutoff,
        limit: 10,
      });
      expect(left.map((e) => e.name)).toEqual(["agent.event"]);
    }
    // Nothing is older than a cutoff in the past.
    expect(await activityRetention.purgeBefore(new Date(Date.now() - DAY), { keepNames: [] })).toBe(0);
  });

  it("stores a short redacted message for events written without one", async () => {
    const ctx = await provision("ret-msg");
    const { activity } = db.current.repos;
    const stored = await activity.append(ctx, {
      name: "agent.event",
      level: "info",
      attributes: { type: "tool_start", id: "t1", name: "bash" },
    });
    expect(stored.message).toBe("tool bash started");
    const explicit = await activity.append(ctx, {
      name: "x",
      level: "info",
      message: "given",
      attributes: { type: "tool_start", id: "t1", name: "bash" },
    });
    expect(explicit.message).toBe("given");
    const silent = await activity.append(ctx, { name: "y", level: "info", attributes: { count: 1 } });
    expect(silent.message).toBeUndefined();
  });

  it("orders a window by time first, so a write stamped earlier by another process is not sorted last", async () => {
    const ctx = await provision("ret-order");
    const { activity } = db.current.repos;
    const base = Date.now() - 60_000;
    const at = (offset: number) => {
      clock.set(new Date(base + offset));
    };
    at(2000);
    await activity.append(ctx, {
      id: "act_zzz",
      name: "later-time-smaller-id-last",
      level: "info",
      attributes: {},
    });
    at(1000);
    await activity.append(ctx, {
      id: "act_zzzz",
      name: "earlier-time-bigger-id",
      level: "info",
      attributes: {},
    });
    const rows = await activity.window(ctx, { from: new Date(base - 1000), to: new Date(), limit: 10 });
    expect(rows.map((e) => e.name)).toEqual(["earlier-time-bigger-id", "later-time-smaller-id-last"]);
  });
});
