import type { TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { describe, expect, it } from "vitest";
import { createPostgresUsageLedger, USAGE_KINDS, usageDedupeKey } from "../src/index.ts";

const db = withTestDatabase();

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "system", id: "test" },
  };
}

describe("Postgres usage ledger", () => {
  it("never duplicates an event under concurrent retries and rolls up per job", async () => {
    const ctx = await tenant("ledger");
    const { job } = await db.current.repos.queue.enqueue(ctx, {
      kind: "video.create",
      payload: {},
      createdBy: { type: "system", id: "test" },
    });
    const ledger = createPostgresUsageLedger(db.current.db);
    const key = usageDedupeKey({ jobId: job.id, stage: "render", attempt: 1, item: "render" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ledger.record(ctx, {
          dedupeKey: key,
          kind: USAGE_KINDS.renderSeconds,
          quantity: 12,
          unit: "s",
          costCents: 2.5,
          jobId: job.id,
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await ledger.record(ctx, {
      dedupeKey: usageDedupeKey({ jobId: job.id, stage: "plan", attempt: 1, item: "decision" }),
      kind: USAGE_KINDS.providerDecision,
      quantity: 1,
      unit: "call",
      costCents: 0.75,
      jobId: job.id,
    });
    expect(await ledger.jobCostCents(ctx, job.id)).toBeCloseTo(3.25);
    expect(await ledger.listForJob(ctx, job.id)).toHaveLength(2);
  });
});
