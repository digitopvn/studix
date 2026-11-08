import type { TenantContext } from "@studix/core";
import { createManualClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-11-08T00:00:00Z");
const clock = createManualClock(NOW);
const db = withTestDatabase({ clock });

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

describe("activity retention (Postgres)", () => {
  it("deletes expired events of every workspace in batches, keeps the job chat and recent events", async () => {
    const { activity } = db.current.repos;
    const a = await provision("ret-a");
    const b = await provision("ret-b");
    clock.set(new Date(NOW.getTime() - 8 * DAY));
    for (let i = 0; i < 5; i++)
      await activity.append(a, { name: "job.progress", level: "debug", attributes: {} });
    await activity.append(b, { name: "job.failed", level: "error", attributes: {} });
    await activity.append(a, { name: "agent.event", level: "info", attributes: { type: "message" } });
    clock.set(new Date(NOW.getTime() - DAY));
    await activity.append(a, { name: "job.done", level: "info", attributes: {} });
    clock.set(NOW);

    const before = new Date(NOW.getTime() - 7 * DAY);
    const keepNames = ["agent.event"];
    expect(await activity.purgeBefore(before, { limit: 4, keepNames })).toBe(4);
    expect(await activity.purgeBefore(before, { limit: 4, keepNames })).toBe(2);
    expect(await activity.purgeBefore(before, { limit: 4, keepNames })).toBe(0);

    const all = { from: new Date(0), to: NOW, limit: 100 };
    expect((await activity.window(a, all)).map((e) => e.name).sort()).toEqual(["agent.event", "job.done"]);
    expect(await activity.window(b, all)).toEqual([]);
  });

  it("gives an event without a message a short redacted one from its attributes", async () => {
    const { activity } = db.current.repos;
    const ctx = await provision("ret-msg");
    const withText = await activity.append(ctx, {
      name: "agent.event",
      level: "info",
      attributes: { type: "tool_start", name: "bash" },
    });
    expect(withText.message).toBe("tool_start: bash");
    const none = await activity.append(ctx, { name: "x", level: "info", attributes: { count: 3 } });
    expect(none.message).toBeUndefined();
    const given = await activity.append(ctx, {
      name: "x",
      level: "info",
      message: "explicit",
      attributes: { type: "t", name: "n" },
    });
    expect(given.message).toBe("explicit");
  });
});
