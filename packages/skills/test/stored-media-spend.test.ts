import { StudixError } from "@studix/shared";
import { type StageContext, StageFailedAfterSpend } from "@studix/workflow";
import { describe, expect, it } from "vitest";
import { generateStoredMedia } from "../src/stored-media.ts";

function ctx(storagePut: () => Promise<never>, outputs: unknown[]): StageContext {
  return {
    ctx: {},
    signal: new AbortController().signal,
    job: { id: "job1" },
    mediaJournal: undefined,
    services: {
      media: {
        generate: async () => ({
          provider: "sume",
          model: "grok-image",
          costCents: 2,
          outputs,
          job: { provider: "sume", id: "j1" },
        }),
      },
      storage: { put: storagePut },
    },
  } as unknown as StageContext;
}

const request = {
  assetId: "frame-1",
  kind: "image" as const,
  prompt: "p",
  keyPrefix: "k/frame-1",
  maxCostCents: 5,
};

describe("generateStoredMedia spend", () => {
  it("bills the generation when the upload fails", async () => {
    const s = ctx(async () => {
      throw new StudixError("UNAVAILABLE", "storage down");
    }, [{ mime: "image/png", filePath: new URL(import.meta.url).pathname }]);
    const err = await generateStoredMedia(s, "designs", request, "/tmp").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    const spent = err as StageFailedAfterSpend;
    expect(spent.error.message).toBe("storage down");
    expect(spent.usage).toHaveLength(1);
    expect(spent.usage[0]?.costCents).toBe(2);
    expect(spent.usage[0]?.upstreamJob).toBe("sume:j1");
  });

  it("bills the generation when the provider returns no output", async () => {
    const s = ctx(async () => undefined as never, []);
    const err = await generateStoredMedia(s, "designs", request, "/tmp").catch((e: unknown) => e);
    expect((err as StageFailedAfterSpend).usage[0]?.costCents).toBe(2);
  });
});
