import type { TenantContext } from "@studix/core";
import { createManualClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const clock = createManualClock(new Date("2026-11-08T00:00:00Z"));
const db = withTestDatabase({ clock });
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

describe("activity repository log filters", () => {
  it("filters by time, minimum level and text, in both directions, inside the tenant", async () => {
    const { activity } = db.current.repos;
    const ctx = await tenant("log-filters");
    const other = await tenant("log-filters-other");
    const add = async (level: "debug" | "info" | "warn" | "error", message: string, jobId?: string) => {
      clock.advance(60_000);
      return activity.append(ctx, {
        name: "evt",
        level,
        message,
        ...(jobId ? { jobId } : {}),
        attributes: {},
      });
    };
    await add("debug", "d 100%_literal");
    const mid = await add("info", "i one");
    await add("warn", "w two", "job_a");
    await add("error", "e three", "job_a");
    clock.advance(60_000);
    await activity.append(other, { name: "evt", level: "error", message: "other tenant", attributes: {} });

    const all = await activity.list(ctx, {});
    expect(all.items.map((e) => e.message)).toEqual(["e three", "w two", "i one", "d 100%_literal"]);

    const warnUp = await activity.list(ctx, { minLevel: "warn" });
    expect(warnUp.items.map((e) => e.level)).toEqual(["error", "warn"]);

    const window = await activity.list(ctx, { since: mid.createdAt, until: mid.createdAt });
    expect(window.items.map((e) => e.message)).toEqual(["i one"]);

    expect((await activity.list(ctx, { search: "TWO" })).items).toHaveLength(1);
    // LIKE wildcards in the term are literal characters.
    expect((await activity.list(ctx, { search: "100%_" })).items).toHaveLength(1);
    expect((await activity.list(ctx, { search: "%" })).items).toHaveLength(1);
    expect((await activity.list(ctx, { search: "_" })).items).toHaveLength(1);

    const asc = await activity.list(ctx, { order: "asc", jobId: "job_a" });
    expect(asc.items.map((e) => e.message)).toEqual(["w two", "e three"]);
    const afterFirst = await activity.list(ctx, { order: "asc", jobId: "job_a", cursor: asc.items[0]?.id });
    expect(afterFirst.items.map((e) => e.message)).toEqual(["e three"]);

    const paged = await activity.list(ctx, { limit: 2 });
    expect(paged.items).toHaveLength(2);
    expect(paged.nextCursor).toBeDefined();
    const rest = await activity.list(ctx, { limit: 2, cursor: paged.nextCursor });
    expect(rest.items.map((e) => e.message)).toEqual(["i one", "d 100%_literal"]);
  });
});
