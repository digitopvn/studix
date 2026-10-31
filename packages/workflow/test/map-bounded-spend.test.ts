import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { mapBounded, StageFailedAfterSpend, type StageUsage } from "../src/index.ts";

const line = (item: string): StageUsage => ({
  item,
  kind: "media_generation",
  quantity: 1,
  unit: "image",
  costCents: 2,
});

describe("mapBounded spend", () => {
  it("bills completed and in-flight items when a sibling fails", async () => {
    const run = mapBounded(
      [0, 1, 2, 3],
      3,
      async (i) => {
        if (i === 0) throw new StudixError("UNAVAILABLE", "put failed");
        await new Promise((r) => setTimeout(r, 10));
        return { usage: line(`m${i}`) };
      },
      { usageOf: (r) => [r.usage] },
    );
    const err = await run.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    const spent = err as StageFailedAfterSpend;
    expect(spent.error.message).toBe("put failed");
    expect(spent.usage.map((u) => u.item).sort()).toEqual(["m1", "m2"]);
  });

  it("merges spend carried by failing items", async () => {
    const err = await mapBounded(
      [0, 1],
      2,
      async (i) => {
        if (i === 0) throw new StageFailedAfterSpend(new StudixError("UNAVAILABLE", "x"), [line("a")]);
        return { usage: line("b") };
      },
      { usageOf: (r) => [r.usage] },
    ).catch((e: unknown) => e);
    expect((err as StageFailedAfterSpend).usage.map((u) => u.item).sort()).toEqual(["a", "b"]);
  });

  it("rethrows the plain error when nothing was spent or usageOf is absent", async () => {
    const boom = new Error("boom");
    await expect(
      mapBounded([0], 1, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expect(
      mapBounded(
        [0],
        1,
        async () => {
          throw boom;
        },
        { usageOf: () => [] },
      ),
    ).rejects.toBe(boom);
  });
});
