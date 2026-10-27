import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { createJobBudgetPolicy, toBudgetCents, USAGE_KINDS, usageDedupeKey } from "../src/index.ts";
import { createInMemoryUsageLedger } from "../src/testing.ts";

const usage = (key: string, costCents: number, jobId = "job_1") => ({
  dedupeKey: key,
  kind: USAGE_KINDS.renderSeconds,
  quantity: 10,
  unit: "s",
  costCents,
  jobId,
});

describe("usage ledger", () => {
  it("records idempotently by dedupe key and rolls up cost per job", async () => {
    const ledger = createInMemoryUsageLedger();
    const ctx = testTenant();
    const key = usageDedupeKey({ jobId: "job_1", stage: "render", attempt: 1, item: "render" });
    expect(key).toBe("job_1:render:1:render");

    const first = await ledger.record(ctx, usage(key, 12.5));
    const retry = await ledger.record(ctx, usage(key, 12.5));
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.event.id).toBe(first.event.id);

    await ledger.record(ctx, usage("job_1:plan:1:decision", 3));
    await ledger.record(ctx, usage("job_2:plan:1:decision", 99, "job_2"));
    expect(await ledger.jobCostCents(ctx, "job_1")).toBe(15.5);
    expect((await ledger.listForJob(ctx, "job_1")).map((e) => e.dedupeKey)).toEqual([
      key,
      "job_1:plan:1:decision",
    ]);
  });

  it("isolates dedupe keys per workspace", async () => {
    const ledger = createInMemoryUsageLedger();
    const a = await ledger.record(testTenant(), usage("same", 1));
    const b = await ledger.record(testTenant(), usage("same", 1));
    expect(a.created && b.created).toBe(true);
  });

  it("rejects malformed usage and key parts", async () => {
    const ledger = createInMemoryUsageLedger();
    await expect(ledger.record(testTenant(), usage("k", -1))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(ledger.record(testTenant(), usage("k", Number.NaN))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(() => usageDedupeKey({ jobId: "job 1", stage: "x", attempt: 1, item: "y" })).toThrow();
    expect(() => usageDedupeKey({ jobId: "job_1", stage: "x", attempt: 0, item: "y" })).toThrow();
  });

  it("rounds fractional COGS up to whole budget cents", () => {
    expect(toBudgetCents(0)).toBe(0);
    expect(toBudgetCents(1.0001)).toBe(2);
    expect(toBudgetCents(3)).toBe(3);
  });
});

describe("job budget policy", () => {
  const policy = createJobBudgetPolicy();
  const ctx = testTenant();

  it("allows spend within budget and without a budget", async () => {
    await expect(
      policy.authorizeSpend(ctx, {
        purpose: "render",
        estimatedCostCents: 10,
        budgetCents: 50,
        spentCents: 40,
      }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      policy.authorizeSpend(ctx, { purpose: "render", estimatedCostCents: 1000 }),
    ).resolves.toEqual({
      allowed: true,
    });
  });

  it("refuses spend over budget and fails closed on bad numbers", async () => {
    await expect(
      policy.authorizeSpend(ctx, {
        purpose: "render",
        estimatedCostCents: 11,
        budgetCents: 50,
        spentCents: 40,
      }),
    ).resolves.toMatchObject({ allowed: false, code: "BUDGET_EXCEEDED" });
    await expect(
      policy.authorizeSpend(ctx, { purpose: "render", estimatedCostCents: Number.NaN, budgetCents: 50 }),
    ).resolves.toMatchObject({ allowed: false, code: "FORBIDDEN" });
    await expect(
      policy.authorizeSpend(ctx, { purpose: "render", estimatedCostCents: 1, budgetCents: -5 }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
