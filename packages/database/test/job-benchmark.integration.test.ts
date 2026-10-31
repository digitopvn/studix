import type { Storyboard, VideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { computeBenchmark, loadBenchmarkRows } from "../src/benchmark/job-benchmark.ts";
import * as schema from "../src/schema/index.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const by = { createdByType: "user" as const, createdById: "usr_1" };
const sha = (c: string) => c.repeat(64);
const irWith = (...hashes: string[]) =>
  ({ assets: hashes.map((h, i) => ({ id: `a${i}`, sha256: h })) }) as unknown as VideoIR;
const at = (seconds: number) => new Date(Date.parse("2026-10-31T00:00:00Z") + seconds * 1000);

describe("Postgres job benchmark loader", () => {
  it("reads the rows of the requested jobs, cache hits and reused assets", async () => {
    const { workspace, organization } = await db.current.repos.directory.provisionWorkspace({
      organization: { name: "bench", slug: "bench" },
      workspace: { name: "Main", slug: "main" },
    });
    const tenant = { organizationId: organization.id, workspaceId: workspace.id };
    const d = db.current.db;

    await d.insert(schema.videoProjects).values({
      id: "prj_1",
      ...tenant,
      ...by,
      title: "Bench",
      status: "in_review",
      brief: { prompt: "bench" },
      workflowTemplate: "marketing-video",
    });
    await d.insert(schema.projectVersions).values([
      {
        id: "ver_old",
        ...tenant,
        ...by,
        projectId: "prj_1",
        version: 1,
        schemaVersion: 1,
        ir: irWith(sha("a")),
        source: "planner",
        createdAt: at(-60),
      },
      {
        id: "ver_1",
        ...tenant,
        ...by,
        projectId: "prj_1",
        version: 2,
        schemaVersion: 1,
        ir: irWith(sha("a"), sha("b")),
        source: "patch",
        createdAt: at(30),
      },
    ]);
    const job = { ...tenant, ...by, kind: "video.create", payload: {}, projectId: "prj_1" };
    await d.insert(schema.jobs).values([
      { id: "job_cache", ...job, status: "succeeded", createdAt: at(-120) },
      { id: "job_1", ...job, status: "succeeded", createdAt: at(0), finishedAt: at(400) },
    ]);
    await d.insert(schema.stageCache).values({
      id: "stc_1",
      ...tenant,
      stage: "marketing-video.script",
      cacheKey: "k1",
      output: { script: "cached" },
      jobId: "job_cache",
    });
    await d.insert(schema.stages).values([
      {
        id: "stg_1",
        ...tenant,
        jobId: "job_1",
        name: "marketing-video.script",
        attempt: 1,
        status: "succeeded",
        output: { script: "cached" },
      },
      {
        id: "stg_2",
        ...tenant,
        jobId: "job_1",
        name: "marketing-video.qa",
        attempt: 1,
        status: "failed",
        error: {
          code: "VALIDATION",
          message: "QA hard gate failed: x",
          retryable: false,
          details: { failures: [{ message: "x" }] },
        },
      },
      {
        id: "stg_3",
        ...tenant,
        jobId: "job_1",
        name: "marketing-video.qa",
        attempt: 2,
        status: "succeeded",
        output: { pass: true },
      },
    ]);
    await d.insert(schema.providerExecutions).values({
      id: "pex_1",
      ...tenant,
      jobId: "job_1",
      provider: "multix",
      operation: "media.video",
      status: "succeeded",
      latencyMs: 1000,
      costCents: 120.25,
      attempt: 1,
    });
    await d.insert(schema.usageEvents).values([
      {
        id: "use_1",
        ...tenant,
        dedupeKey: "d1",
        kind: "media.generation",
        quantity: 1,
        unit: "clip",
        costCents: 120.25,
        jobId: "job_1",
        providerExecutionId: "pex_1",
      },
      {
        id: "use_2",
        ...tenant,
        dedupeKey: "d2",
        kind: "agent.run",
        quantity: 1000,
        unit: "token",
        costCents: 30,
        jobId: "job_1",
      },
    ]);
    await d.insert(schema.approvals).values({
      id: "apr_1",
      ...tenant,
      action: "creative.gate",
      subjectType: "job",
      subjectId: "job_1",
      status: "approved",
      reason: "G1",
      scopeKey: "gate:g1",
      requestedByType: "system",
      requestedById: "worker",
      decidedByType: "user",
      decidedById: "usr_1",
      decidedAt: at(100),
      createdAt: at(40),
    });
    await d.insert(schema.renders).values({
      id: "rnd_1",
      ...tenant,
      projectId: "prj_1",
      versionId: "ver_1",
      jobId: "job_1",
      preset: "final",
      spec: { preset: "final" } as never,
      status: "succeeded",
      probe: { durationMs: 20_000, width: 1080, height: 1920, fps: 30, videoCodec: "h264", bytes: 1 },
      createdAt: at(300),
      completedAt: at(360),
    });
    const storyboard = (status: string) => ({ approval: { status } }) as unknown as Storyboard;
    await d.insert(schema.projectStoryboards).values([
      {
        id: "sb_1",
        ...tenant,
        ...by,
        projectId: "prj_1",
        revision: 1,
        versionId: "ver_old",
        storyboard: storyboard("changes_requested"),
      },
      {
        id: "sb_2",
        ...tenant,
        ...by,
        projectId: "prj_1",
        revision: 2,
        versionId: "ver_1",
        storyboard: storyboard("approved"),
      },
    ]);

    const rows = await loadBenchmarkRows(db.current.client, ["job_1", "job_nope"]);
    expect(rows.jobs.map((j) => j.id)).toEqual(["job_1"]);
    expect(rows.jobs[0]!.workflowTemplate).toBe("marketing-video");
    expect(rows.stages.find((s) => s.name === "marketing-video.script")!.fromCache).toBe(true);
    expect(rows.stages.filter((s) => s.fromCache)).toHaveLength(1);
    expect(rows.assets.sort((a, b) => a.sha256.localeCompare(b.sha256))).toEqual([
      { jobId: "job_1", sha256: sha("a"), reused: true },
      { jobId: "job_1", sha256: sha("b"), reused: false },
    ]);
    expect(rows.projects).toEqual([
      { projectId: "prj_1", patchVersions: 1, storyboardDecisions: 2, storyboardChangeRequests: 1 },
    ]);

    const report = computeBenchmark(rows, ["job_1", "job_nope"]);
    expect(report.missingJobIds).toEqual(["job_nope"]);
    expect(report.jobs[0]).toMatchObject({
      timeToPreviewMs: 360_000,
      timeToPreviewExcludingGatesMs: 300_000,
      videoSeconds: 20,
      costCents: 150.25,
      agentCostPerVideoSecondCents: 1.5,
      cachedStages: 1,
      qaRuns: 2,
      qaPassed: 1,
      providerExecutions: 1,
      interventions: 1,
    });
    expect(report.summary).toMatchObject({ revisionRounds: 2, interventions: 3, assetReuseRate: 0.5 });
  });

  it("returns no rows for unknown jobs", async () => {
    const rows = await loadBenchmarkRows(db.current.client, ["job_unknown"]);
    expect(rows.jobs).toEqual([]);
  });
});
