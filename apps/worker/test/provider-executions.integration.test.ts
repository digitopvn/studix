import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { USAGE_KINDS } from "@studix/billing";
import type { StorageAdapter, TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { DecisionRouter, FakeDecisionAdapter, RulesAdapter } from "@studix/decision-routing";
import { createLogger, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { runWorkerProcess } from "../src/index.ts";
import { registerBriefRule, VIDEO_BRIEF_DECISION } from "../src/planner/brief-decision.ts";
import { createExecutionSink } from "../src/planner/execution-sink.ts";
import { createVideoPlanner } from "../src/planner/video-planner.ts";

const db = withTestDatabase();
const logger = createLogger({}, { level: "error", write: () => {} });
const actor = { type: "user", id: "usr_1" } as const;

const storage = {
  async put(_ctx: TenantContext, key: string, _body: { filePath: string }, opts: { contentType: string }) {
    return { key, bytes: 8, sha256: "0".repeat(64), contentType: opts.contentType };
  },
} as unknown as StorageAdapter;

const renderer = {
  id: "fake",
  supports: () => ({ supported: true, reasons: [] }),
  async render(_ir: unknown, opts: { workDir: string }) {
    const filePath = join(opts.workDir, "out.mp4");
    await writeFile(filePath, "fake-mp4");
    return {
      filePath,
      mime: "video/mp4",
      probe: { durationMs: 15_000, width: 540, height: 960, fps: 30, videoCodec: "h264", bytes: 8 },
    };
  },
};

describe("decision provider executions", () => {
  it("records one provider execution per decision attempt and links the winning one from usage", async () => {
    // Primary fails twice (retryable), the deterministic rules fallback wins: 3 attempts in total.
    const primary = new FakeDecisionAdapter({
      id: "openrouter",
      steps: [
        { error: new StudixError("UNAVAILABLE", "upstream down") },
        { error: new StudixError("UNAVAILABLE", "upstream down") },
      ],
    });
    const rules = registerBriefRule(new RulesAdapter({ logger }));
    const router = new DecisionRouter({
      providers: [primary, rules],
      defaultRoute: ["openrouter", "rules"],
      retryBackoffMs: 0,
      sink: createExecutionSink(db.current.repos.usage),
      logger,
    });
    const worker = await runWorkerProcess({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: db.current.url,
        WORKER_HEALTH_PORT: "0",
        WORKER_HEALTH_HOST: "127.0.0.1",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_ID: "pex-worker",
      },
      resolvePorts: async () => ({
        storage,
        renderer,
        planner: createVideoPlanner({ decisions: router, logger }),
      }),
      logger,
      handleSignals: false,
    });

    const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
      organization: { name: "pex", slug: "pex" },
      workspace: { name: "Main", slug: "main" },
    });
    const ctx: TenantContext = {
      organizationId: organization.id,
      workspaceId: workspace.id,
      actor: { type: "user", id: "usr_1", role: "owner" },
    };
    const project = await db.current.repos.projects.create(ctx, {
      title: "Pex",
      status: "draft",
      brief: { prompt: "Giới thiệu thương hiệu Studix, video dọc 9:16" },
      createdBy: actor,
    });
    const { job } = await db.current.repos.queue.enqueue(ctx, {
      kind: "video.create",
      projectId: project.id,
      payload: { projectId: project.id },
      createdBy: actor,
    });

    const until = Date.now() + 15_000;
    let status = job.status;
    while (status !== "succeeded" && status !== "failed" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      status = (await db.current.repos.jobs.get(ctx, job.id))!.status;
    }
    await worker.shutdown();
    expect(status).toBe("succeeded");

    // Listed newest first; reverse into attempt order.
    const executions = (
      await db.current.repos.usage.listProviderExecutions(ctx, { jobId: job.id })
    ).items.reverse();
    expect(executions.map((e) => [e.provider, e.attempt, e.status, e.operation])).toEqual([
      ["openrouter", 1, "failed", `decision.${VIDEO_BRIEF_DECISION}`],
      ["openrouter", 2, "failed", `decision.${VIDEO_BRIEF_DECISION}`],
      ["rules", 1, "succeeded", `decision.${VIDEO_BRIEF_DECISION}`],
    ]);
    expect(executions[0]?.error?.code).toBe("UNAVAILABLE");

    const usage = (await db.current.repos.usage.list(ctx, { jobId: job.id })).items.filter(
      (u) => u.kind === USAGE_KINDS.providerDecision,
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]?.providerExecutionId).toBe(executions[2]?.id);
  });
});
