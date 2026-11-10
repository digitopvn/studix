import { describe, expect, it } from "vitest";
import { SERVER_NAME } from "../src/app-deps.ts";
import { inspectCapabilities } from "../src/mcp/inspect-capabilities.ts";
import { jobRevision, summarizeJob } from "../src/mcp/job-summary.ts";
import type { JobWithVideo } from "../src/resource-views.ts";

const limits = {
  defaultJobBudgetCents: 1,
  defaultJobDeadlineSeconds: 1,
  approvalCostThresholdCents: 1,
  signedUrlTtlSeconds: 1,
};
const base = {
  tenant: { workspaceId: "ws_1" } as never,
  limits: limits as never,
  skills: [],
  toolNames: [],
};

describe("studix_inspect schemaNames", () => {
  it("returns only the named schemas, far smaller than all of them", () => {
    const one = inspectCapabilities({ ...base, include: [], schemaNames: ["creative-brief"] }) as {
      schemas: Record<string, unknown>;
      schemasEtag: string;
    };
    const all = inspectCapabilities({ ...base, include: ["schemas"] }) as {
      schemas: Record<string, unknown>;
    };
    expect(Object.keys(one.schemas)).toEqual(["creative-brief"]);
    expect(one.schemasEtag).toBeTruthy();
    expect(JSON.stringify(one).length).toBeLessThan(JSON.stringify(all).length / 2);
  });

  it("stays compact without schema options", () => {
    expect(inspectCapabilities({ ...base, include: [] })).not.toHaveProperty("schemas");
    expect(SERVER_NAME).toBeTruthy();
  });
});

describe("job summary view", () => {
  const job = {
    id: "job_1",
    kind: "video.create",
    status: "failed",
    projectId: "prj_1",
    stage: "render",
    progress: 0.4,
    attempts: 1,
    maxAttempts: 3,
    cancelRequested: false,
    budget: { spentCents: 12, limitCents: 500 },
    createdAt: new Date("2026-11-10T00:00:00Z"),
    updatedAt: new Date("2026-11-10T00:01:00Z"),
    error: { code: "TIMEOUT", message: "render timed out", retryable: true, suggestedAction: "Retry." },
    stages: [
      { name: "plan", status: "succeeded", attempt: 1 },
      { name: "render", status: "failed", attempt: 1 },
    ],
    agent: { runtime: "pi" },
    next: [],
  } as unknown as JobWithVideo;

  it("drops the stage list, keeps the failing stage and the fix", () => {
    const s = summarizeJob(
      job,
      [{ tool: "studix_retry_job", arguments: { jobId: "job_1" }, reason: "r" }],
      undefined,
    );
    expect(s).not.toHaveProperty("stages");
    expect(s.error).toMatchObject({ code: "TIMEOUT", stage: "render", suggestedAction: "Retry." });
    expect(s.nextAction?.tool).toBe("studix_retry_job");
    expect(s.revision).toBe(jobRevision(job));
  });

  it("changes revision when the status changes", () => {
    expect(jobRevision({ ...job, status: "running" })).not.toBe(jobRevision(job));
  });
});
