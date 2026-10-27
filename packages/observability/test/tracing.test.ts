import { SpanStatusCode, trace } from "@opentelemetry/api";
import { testTenant } from "@studix/core/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { activeTraceIds, scopeFromTenant, startSpan, withSpan } from "../src/index.ts";
import { useInMemoryTracing } from "./otel-test-provider.ts";

const exporter = useInMemoryTracing();

describe("startSpan", () => {
  it("attaches studix scope attributes and redacts secrets in extra attributes", () => {
    const ctx = testTenant();
    const span = startSpan("provider.call", {
      scope: scopeFromTenant(ctx, {
        projectId: "prj_1",
        jobId: "job_1",
        stage: "render",
        provider: "fal",
        model: "veo-3",
      }),
      attributes: {
        apiKey: "sk-live-should-never-leak",
        url: "https://cdn.example.com/a.mp4?X-Amz-Signature=abcdef123456",
        prompt: "use Bearer abcdefghijklmnop",
        body: { nested: { token: "t0ps3cret-value" }, ok: 1 },
        count: 3,
        tags: ["a", "b"],
        missing: undefined,
      },
    });
    span.end();
    const [finished] = exporter.getFinishedSpans();
    expect(finished?.attributes).toEqual({
      "studix.organization.id": ctx.organizationId,
      "studix.workspace.id": ctx.workspaceId,
      "studix.project.id": "prj_1",
      "studix.job.id": "job_1",
      "studix.stage": "render",
      "studix.provider": "fal",
      "studix.model": "veo-3",
      apiKey: "[redacted]",
      url: "https://cdn.example.com/a.mp4?X-Amz-Signature=[redacted]",
      prompt: "use Bearer [redacted]",
      body: '{"nested":{"token":"[redacted]"},"ok":1}',
      count: 3,
      tags: ["a", "b"],
    });
  });

  it("does not let extra attributes override scope attributes", () => {
    startSpan("x", { scope: { jobId: "job_real" }, attributes: { "studix.job.id": "job_forged" } }).end();
    expect(exporter.getFinishedSpans()[0]?.attributes["studix.job.id"]).toBe("job_real");
  });
});

describe("withSpan", () => {
  it("makes the span active, nests children and ends with OK", async () => {
    const result = await withSpan("outer", {}, async (outer) => {
      expect(activeTraceIds()).toEqual({
        traceId: outer.spanContext().traceId,
        spanId: outer.spanContext().spanId,
      });
      await withSpan("inner", {}, async () => undefined);
      return 42;
    });
    expect(result).toBe(42);
    const spans = exporter.getFinishedSpans();
    const outer = spans.find((s) => s.name === "outer");
    const inner = spans.find((s) => s.name === "inner");
    expect(outer?.status.code).toBe(SpanStatusCode.OK);
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it("records a redacted error, rethrows the original and still ends the span", async () => {
    const failure = new StudixError("PROVIDER_ERROR", "upstream rejected key sk-proj-abcdefghijklmnopqrst");
    await expect(withSpan("call", {}, () => Promise.reject(failure))).rejects.toBe(failure);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "upstream rejected key [redacted]" });
    expect(span?.attributes["studix.error.code"]).toBe("PROVIDER_ERROR");
    const exception = JSON.stringify(span?.events);
    expect(exception).not.toContain("abcdefghijklmnopqrst");
  });
});

describe("activeTraceIds", () => {
  it("is undefined outside a span", () => {
    expect(activeTraceIds()).toBeUndefined();
  });
});
