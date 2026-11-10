import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { inspectCapabilities } from "../src/mcp/inspect-capabilities.ts";
import { summarizeJob } from "../src/mcp/job-summary.ts";

const base = {
  tenant: testTenant(),
  limits: {
    defaultJobBudgetCents: 1,
    defaultJobDeadlineSeconds: 1,
    approvalCostThresholdCents: 1,
    signedUrlTtlSeconds: 1,
  },
  skills: [],
  toolNames: [],
} as unknown as Parameters<typeof inspectCapabilities>[0];

describe("studix_inspect schema selection", () => {
  it("lists schema names but no schemas by default", () => {
    const out = inspectCapabilities({ ...base, include: [] }) as Record<string, unknown>;
    expect(out.schemaNames).toContain("creative-brief");
    expect(out.schemas).toBeUndefined();
  });

  it("returns only the requested schemas, and all with include", () => {
    const one = inspectCapabilities({ ...base, include: [], schemaNames: ["creative-brief"] }) as {
      schemas: Record<string, unknown>;
    };
    expect(Object.keys(one.schemas)).toEqual(["creative-brief"]);
    const all = inspectCapabilities({ ...base, include: ["schemas"] }) as {
      schemas: Record<string, unknown>;
    };
    expect(Object.keys(all.schemas).length).toBeGreaterThan(1);
    expect(JSON.stringify(one).length).toBeLessThan(JSON.stringify(all).length / 2);
  });
});

describe("job summary view", () => {
  const job = {
    id: "job_1",
    kind: "video.create",
    status: "failed",
    stage: "render",
    progress: 0.4,
    attempts: 1,
    maxAttempts: 3,
    budget: { spentCents: 5 },
    agent: {},
    updatedAt: new Date(),
    stages: [{ name: "plan" }, { name: "render" }],
    error: { code: "TIMEOUT", message: "render timed out", retryable: true, suggestedAction: "retry" },
    next: [],
  } as never;

  it("drops per-stage history and names the blocker", () => {
    const view = summarizeJob(job) as Record<string, unknown>;
    expect(view.stages).toBeUndefined();
    expect(view.blocker).toMatchObject({ kind: "error", code: "TIMEOUT", retryable: true });
  });
});
