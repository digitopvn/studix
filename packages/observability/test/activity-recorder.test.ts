import type { ActivityRepository } from "@studix/core";
import { createInMemoryActivityRepository, testTenant } from "@studix/core/testing";
import { createLogger, createManualClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createActivityRecorder, withSpan } from "../src/index.ts";
import { useInMemoryTracing } from "./otel-test-provider.ts";

useInMemoryTracing();

function setup(repository?: ActivityRepository) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    {},
    { write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  const repo =
    repository ?? createInMemoryActivityRepository(createManualClock(new Date("2026-10-27T00:00:00Z")));
  return { repo, lines, recorder: createActivityRecorder(repo, { logger }) };
}

describe("createActivityRecorder", () => {
  it("writes a redacted, tenant-scoped event correlated with the active span", async () => {
    const { repo, recorder } = setup();
    const ctx = testTenant();
    const { event, traceId, spanId } = await withSpan("stage", {}, async (span) => ({
      event: await recorder.record(ctx, {
        name: "provider.request",
        message: "calling with Bearer abcdefghijklmnop",
        scope: { projectId: "prj_1", jobId: "job_1", stage: "generate", provider: "fal", model: "flux" },
        durationMs: 120,
        attributes: { headers: { authorization: "Basic xyz12345678" }, password: "hunter2hunter2", seed: 7 },
      }),
      ...span.spanContext(),
    }));
    expect(event).toMatchObject({
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      name: "provider.request",
      level: "info",
      message: "calling with Bearer [redacted]",
      projectId: "prj_1",
      jobId: "job_1",
      stage: "generate",
      provider: "fal",
      model: "flux",
      durationMs: 120,
      traceId,
      spanId,
      attributes: { headers: { authorization: "[redacted]" }, password: "[redacted]", seed: 7 },
    });
    const listed = await repo.list(ctx, { traceId });
    expect(listed.items.map((e) => e.id)).toEqual([event?.id]);
    expect((await repo.list(testTenant())).items).toEqual([]);
  });

  it("omits trace ids outside a span and does not mix an explicit trace with the active span id", async () => {
    const { recorder } = setup();
    const ctx = testTenant();
    const plain = await recorder.record(ctx, { name: "job.created" });
    expect(plain).not.toHaveProperty("traceId");
    const explicit = await withSpan("other", {}, () =>
      recorder.record(ctx, { name: "imported", traceId: "0af7651916cd43dd8448eb211c80319c" }),
    );
    expect(explicit).toMatchObject({ traceId: "0af7651916cd43dd8448eb211c80319c" });
    expect(explicit).not.toHaveProperty("spanId");
  });

  it("logs and returns undefined when storage fails instead of failing the caller", async () => {
    const failing: ActivityRepository = {
      append: () => Promise.reject(new Error("connection lost to postgres://u:pw1234567@db/x")),
      list: () => Promise.reject(new Error("unused")),
      listAfter: () => Promise.reject(new Error("unused")),
      window: () => Promise.reject(new Error("unused")),
    };
    const { recorder, lines } = setup(failing);
    await expect(recorder.record(testTenant(), { name: "job.failed" })).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      msg: "activity event not recorded",
      event: "job.failed",
    });
    expect(JSON.stringify(lines[0])).not.toContain("pw1234567");
  });
});
