import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaGenerationRequest, NewProviderExecution } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createManualClock, StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  centsFromPrice,
  type FakeMediaPricing,
  FakeMediaProvider,
  InMemoryMediaPriceBook,
  mediaBillingQuantity,
  runMediaBatchWithProbe,
} from "../src/index.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "studix-probe-batch-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const ctx = testTenant();
const clock = createManualClock(Date.UTC(2026, 9, 31));
const batch = (n: number, overrides: Partial<MediaGenerationRequest> = {}): MediaGenerationRequest[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: "image" as const,
    prompt: `frame ${i}`,
    idempotencyKey: `shot-${i}`,
    maxCostCents: 100,
    workDir,
    ...overrides,
  }));

function pricedFake(pricing: FakeMediaPricing) {
  const provider = new FakeMediaProvider({ pricing });
  const generate = vi.spyOn(provider, "generate");
  return { provider, generate };
}

describe("runMediaBatchWithProbe", () => {
  it("probes an unmeasured model once, records its receipt price, then runs the rest", async () => {
    const { provider, generate } = pricedFake({ estimateCents: () => 4, chargeCents: () => 3 });
    const priceBook = new InMemoryMediaPriceBook();
    const outcome = await runMediaBatchWithProbe(ctx, provider, batch(4), {
      priceBook,
      budgetCents: 100,
      clock,
    });

    expect(outcome).toMatchObject({ status: "completed", spentCents: 12 });
    expect(generate).toHaveBeenCalledTimes(4);
    expect(await priceBook.get("fake:image:default")).toEqual({
      model: "fake:image:default",
      unit: "image",
      centsPerUnit: 3,
      basis: "measured",
      sampleCents: 3,
      sampleQuantity: 1,
      recordedAt: "2026-10-31T00:00:00.000Z",
    });

    // The model is now measured: the next batch runs without a probe stop.
    const next = await runMediaBatchWithProbe(ctx, provider, batch(2), { priceBook, budgetCents: 100 });
    expect(next).toMatchObject({ status: "completed", spentCents: 6 });
  });

  it("stops after the probe when the provider reports no charge", async () => {
    const { provider, generate } = pricedFake({ estimateCents: () => 4, chargeCents: () => undefined });
    const priceBook = new InMemoryMediaPriceBook();
    const outcome = await runMediaBatchWithProbe(ctx, provider, batch(3), { priceBook, budgetCents: 100 });

    expect(outcome).toMatchObject({ status: "stopped", reason: "probe_unpriced", spentCents: 4 });
    expect(generate).toHaveBeenCalledTimes(1);
    if (outcome.status !== "stopped") throw new Error("expected a stop");
    expect(outcome.results.map((r) => r !== null)).toEqual([true, false, false]);
    expect(await priceBook.get("fake:image:default")).toBeUndefined();
  });

  it("stops for review when the probe costs more than its estimate plus the tolerance", async () => {
    const { provider, generate } = pricedFake({ estimateCents: () => 10, chargeCents: () => 13 });
    const priceBook = new InMemoryMediaPriceBook();
    const outcome = await runMediaBatchWithProbe(ctx, provider, batch(3), { priceBook, budgetCents: 100 });

    expect(outcome).toMatchObject({
      status: "stopped",
      reason: "probe_overrun",
      details: { estimateCents: 10, costCents: 13, remaining: 2 },
    });
    expect(generate).toHaveBeenCalledTimes(1);
    // The measured price is kept, so a person can resume the batch knowing the real cost.
    expect(await priceBook.get("fake:image:default")).toMatchObject({ centsPerUnit: 13 });

    // Within tolerance (12 ≤ 10 × 1.2) the batch proceeds.
    const fine = pricedFake({ estimateCents: () => 10, chargeCents: () => 12 });
    const ok = await runMediaBatchWithProbe(ctx, fine.provider, batch(2), {
      priceBook: new InMemoryMediaPriceBook(),
      budgetCents: 100,
    });
    expect(ok.status).toBe("completed");
  });

  it("re-estimates the rest with the measured price and stops before exceeding the budget", async () => {
    // The catalog says 2¢ but the receipt says 2¢ only for the probe's one image; four images cost 8¢ each.
    const { provider, generate } = pricedFake({
      estimateCents: () => 2,
      chargeCents: (r) => 2 * (typeof r.params?.numImages === "number" ? r.params.numImages : 1),
    });
    const requests = [
      ...batch(1),
      ...batch(3, { params: { numImages: 4 } }).map((r, i) => ({ ...r, idempotencyKey: `multi-${i}` })),
    ];
    const outcome = await runMediaBatchWithProbe(ctx, provider, requests, {
      priceBook: new InMemoryMediaPriceBook(),
      budgetCents: 20,
    });
    expect(outcome).toMatchObject({
      status: "stopped",
      reason: "budget_exceeded",
      spentCents: 2,
      details: { plannedCents: 24, budgetCents: 20, remaining: 3 },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not even probe when the probe alone would exceed the budget", async () => {
    const { provider, generate } = pricedFake({ estimateCents: () => 30, chargeCents: () => 30 });
    const outcome = await runMediaBatchWithProbe(ctx, provider, batch(2), {
      priceBook: new InMemoryMediaPriceBook(),
      budgetCents: 25,
    });
    expect(outcome).toMatchObject({ status: "stopped", reason: "budget_exceeded", spentCents: 0 });
    expect(generate).not.toHaveBeenCalled();
  });

  it("probes each model separately", async () => {
    const { provider, generate } = pricedFake({ estimateCents: () => 1, chargeCents: () => 1 });
    const priceBook = new InMemoryMediaPriceBook();
    const requests = [
      ...batch(2),
      ...batch(2, { kind: "voice" }).map((r, i) => ({ ...r, idempotencyKey: `v-${i}` })),
    ];
    const outcome = await runMediaBatchWithProbe(ctx, provider, requests, { priceBook, budgetCents: 10 });
    expect(outcome.status).toBe("completed");
    expect(generate).toHaveBeenCalledTimes(4);
    expect(await priceBook.get("fake:image:default")).toMatchObject({ unit: "image" });
    expect(await priceBook.get("fake:voice:default")).toMatchObject({ unit: "character" });
  });

  it("validates its options", async () => {
    const provider = new FakeMediaProvider();
    const priceBook = new InMemoryMediaPriceBook();
    await expect(
      runMediaBatchWithProbe(ctx, provider, [], { priceBook, budgetCents: -1 }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      runMediaBatchWithProbe(ctx, provider, [], { priceBook, budgetCents: 1, overrunTolerance: Number.NaN }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("media price book", () => {
  it("bills by seconds, characters, images or calls", () => {
    expect(mediaBillingQuantity({ kind: "video", prompt: "x", params: { durationMs: 4500 } })).toEqual({
      unit: "second",
      quantity: 5,
    });
    expect(mediaBillingQuantity({ kind: "voice", prompt: "hello" })).toEqual({
      unit: "character",
      quantity: 5,
    });
    expect(mediaBillingQuantity({ kind: "upscale", prompt: "x", params: { image: "a" } })).toEqual({
      unit: "image",
      quantity: 1,
    });
    expect(mediaBillingQuantity({ kind: "music", prompt: "x" })).toEqual({ unit: "call", quantity: 1 });
  });

  it("prices a request from a measured unit price, or vouches for one sample in another unit", () => {
    const price = {
      model: "m",
      unit: "second" as const,
      centsPerUnit: 1.5,
      basis: "measured" as const,
      sampleCents: 6,
      sampleQuantity: 4,
      recordedAt: "2026-10-31T00:00:00.000Z",
    };
    expect(centsFromPrice(price, { kind: "video", prompt: "x", params: { durationMs: 5000 } })).toBe(8);
    expect(centsFromPrice(price, { kind: "video", prompt: "x" })).toBe(6);
  });

  it("refuses malformed prices", async () => {
    await expect(
      new InMemoryMediaPriceBook().record({
        model: "",
        unit: "call",
        centsPerUnit: -1,
        basis: "accepted",
        sampleCents: 0,
        sampleQuantity: 1,
        recordedAt: "x",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("runMediaBatchWithProbe execution rows", () => {
  it("records every call, failed ones included, against the job and stage", async () => {
    const provider = new FakeMediaProvider({ pricing: { estimateCents: () => 4, chargeCents: () => 3 } });
    const rows: NewProviderExecution[] = [];
    const recorder = {
      recordProviderExecution: async (_c: unknown, input: NewProviderExecution) => {
        rows.push(input);
        return input;
      },
    };
    const outcome = await runMediaBatchWithProbe(ctx, provider, batch(3), {
      priceBook: new InMemoryMediaPriceBook(),
      budgetCents: 100,
      clock,
      executions: { recorder, jobId: "job_1", stageId: "shots" },
    });
    expect(outcome.status).toBe("completed");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "succeeded" && r.jobId === "job_1" && r.stageId === "shots")).toBe(
      true,
    );

    rows.length = 0;
    vi.spyOn(provider, "generate").mockRejectedValueOnce(new StudixError("CANCELLED", "stop"));
    await expect(
      runMediaBatchWithProbe(ctx, provider, batch(1), {
        priceBook: new InMemoryMediaPriceBook(),
        budgetCents: 100,
        clock,
        executions: { recorder },
      }),
    ).rejects.toThrow("stop");
    expect(rows).toEqual([expect.objectContaining({ status: "cancelled", operation: "media.image" })]);
  });
});
