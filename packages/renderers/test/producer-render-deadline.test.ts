import { createLogger } from "@studix/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxRenderMsFor, renderWithProducer } from "../src/hyperframes/producer-render.ts";

const producer = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  failWith: undefined as Error | undefined,
}));

// The real producer needs Chrome and FFmpeg; these tests only cover what Studix passes in and maps out.
vi.mock("@hyperframes/producer", () => {
  class RenderCancelledError extends Error {}
  return {
    RenderCancelledError,
    createRenderJob: (config: Record<string, unknown>) => {
      producer.configs.push(config);
      return { config, status: "queued", progress: 0, currentStage: "capture", warnings: [] };
    },
    executeRenderJob: async (job: { status: string }) => {
      if (producer.failWith) throw producer.failWith;
      job.status = "complete";
    },
  };
});

const log = createLogger({ component: "producer-deadline-test" }, { level: "error" });
const input = {
  projectDir: "p",
  outputPath: "o.mp4",
  fps: 30,
  quality: "draft" as const,
  crf: 23,
  logger: log,
};
const onProgress = () => {};

beforeEach(() => {
  producer.configs.length = 0;
  producer.failWith = undefined;
});

describe("maxRenderMsFor", () => {
  it("is the time left until the deadline", () => {
    expect(maxRenderMsFor(new Date(10_500), 1_000)).toBe(9_500);
  });

  it("leaves the guard off without a deadline or once it has passed", () => {
    expect(maxRenderMsFor(undefined, 1_000)).toBeUndefined();
    expect(maxRenderMsFor(new Date(1_000), 1_000)).toBeUndefined();
    expect(maxRenderMsFor(new Date(500), 1_000)).toBeUndefined();
  });
});

describe("renderWithProducer deadline", () => {
  it("passes the time left until the job deadline as maxRenderMs", async () => {
    await renderWithProducer({ ...input, onProgress, deadlineAt: new Date(Date.now() + 60_000) });
    const budget = producer.configs[0]?.maxRenderMs as number;
    expect(budget).toBeGreaterThan(55_000);
    expect(budget).toBeLessThanOrEqual(60_000);
  });

  it("passes no maxRenderMs without a deadline", async () => {
    await renderWithProducer({ ...input, onProgress });
    expect(producer.configs[0]).not.toHaveProperty("maxRenderMs");
  });

  it("maps the producer's too-slow stop to a non-retryable TIMEOUT", async () => {
    producer.failWith = Object.assign(new Error("render too slow: ETA exceeds maxRenderMs"), {
      name: "RenderTooSlowError",
    });
    await expect(
      renderWithProducer({ ...input, onProgress, deadlineAt: new Date(Date.now() + 60_000) }),
    ).rejects.toMatchObject({ code: "TIMEOUT", retryable: false, suggestedAction: expect.any(String) });
  });

  it("keeps other producer failures INTERNAL", async () => {
    producer.failWith = new Error("browser crashed");
    await expect(renderWithProducer({ ...input, onProgress })).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
