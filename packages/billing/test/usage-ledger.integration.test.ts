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

  it("tags who funded each line and still counts BYOK spend against the job budget", async () => {
    const ctx = await tenant("funding");
    const { job } = await db.current.repos.queue.enqueue(ctx, {
      kind: "video.create",
      payload: {},
      createdBy: { type: "system", id: "test" },
    });
    const usage = db.current.repos.usage;
    const execution = await usage.recordProviderExecution(ctx, {
      jobId: job.id,
      provider: "pi",
      operation: "anime.scope",
      attempt: 1,
      status: "succeeded",
      latencyMs: 10,
      costCents: 20,
      funding: "member",
    });
    const operatorRun = await usage.recordProviderExecution(ctx, {
      jobId: job.id,
      provider: "sume",
      operation: "image",
      attempt: 1,
      status: "succeeded",
      latencyMs: 10,
      costCents: 5,
    });
    expect(execution.funding).toBe("member");
    expect(operatorRun.funding).toBe("operator");

    const ledger = createPostgresUsageLedger(db.current.db);
    await ledger.record(ctx, {
      dedupeKey: usageDedupeKey({ jobId: job.id, stage: "scope", attempt: 1, item: "agent" }),
      kind: USAGE_KINDS.agentRun,
      quantity: 150_000,
      unit: "token",
      costCents: 20,
      jobId: job.id,
      providerExecutionId: execution.id,
      funding: "member",
    });
    await ledger.record(ctx, {
      dedupeKey: usageDedupeKey({ jobId: job.id, stage: "image", attempt: 1, item: "image" }),
      kind: USAGE_KINDS.providerDecision,
      quantity: 1,
      unit: "call",
      costCents: 5,
      jobId: job.id,
    });
    const lines = await ledger.listForJob(ctx, job.id);
    expect(lines.map((l) => [l.kind, l.funding]).sort()).toEqual(
      [
        [USAGE_KINDS.agentRun, "member"],
        [USAGE_KINDS.providerDecision, "operator"],
      ].sort(),
    );
    // BYOK spend is recorded, not charged, but the job's budget cap still counts it.
    expect(await ledger.jobCostCents(ctx, job.id)).toBeCloseTo(25);
  });

  it("replaces an estimate with the receipt exactly once under concurrent writes", async () => {
    const ctx = await tenant("ledger-receipt");
    const { job } = await db.current.repos.queue.enqueue(ctx, {
      kind: "video.create",
      payload: {},
      createdBy: { type: "system", id: "test" },
    });
    const ledger = createPostgresUsageLedger(db.current.db);
    const line = (costCents: number, costSource: string) => ({
      dedupeKey: `${job.id}:media:exec:sume:j1`,
      kind: USAGE_KINDS.mediaGeneration,
      quantity: 1,
      unit: "video",
      costCents,
      jobId: job.id,
      metadata: { costSource },
    });
    await ledger.record(ctx, line(10, "estimate"));
    await Promise.all([ledger.record(ctx, line(7, "receipt")), ledger.record(ctx, line(7, "receipt"))]);
    await ledger.record(ctx, line(10, "estimate"));
    expect(await ledger.jobCostCents(ctx, job.id)).toBe(7);
    const events = await ledger.listForJob(ctx, job.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ costSource: "receipt" });
  });
});
