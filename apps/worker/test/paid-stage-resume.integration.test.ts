import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobBudgetPolicy, createUsageLedger, USAGE_KINDS } from "@studix/billing";
import {
  createDefaultApprovalPolicy,
  type RendererAdapter,
  type StorageAdapter,
  type TenantContext,
} from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { DecisionRouter, FakeDecisionAdapter, RulesAdapter } from "@studix/decision-routing";
import { createLogger, StudixError } from "@studix/shared";
import {
  createJobExecutor,
  createVideoCreateWorkflow,
  createWorkerJobQueue,
  type HeartbeatResult,
  type WorkerJobQueue,
} from "@studix/workflow";
import { describe, expect, it } from "vitest";
import type { BrandLookup } from "../src/planner/brand-lookup-enrichment.ts";
import { registerBriefRule, VIDEO_BRIEF_DECISION } from "../src/planner/brief-decision.ts";
import { createExecutionSink } from "../src/planner/execution-sink.ts";
import { createVideoPlanner } from "../src/planner/video-planner.ts";

const db = withTestDatabase();
const logger = createLogger({}, { level: "error", write: () => {} });
const actor = { type: "user", id: "usr_1" } as const;
/** The fake model provider charges this much per brief decision. */
const DECISION_CENTS = 2;

const storage: StorageAdapter = {
  async put(_ctx, key, body, opts) {
    if (!("filePath" in body)) throw new Error("fake storage only accepts files");
    const bytes = await readFile(body.filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { key, bytes: bytes.length, sha256, contentType: opts.contentType };
  },
  get: async () => {
    throw new Error("not used");
  },
  download: async () => {
    throw new Error("not used");
  },
  head: async () => undefined,
  signedUrl: async (_ctx, key) => `https://storage.test/${key}`,
  delete: async () => {},
};

const renderer: RendererAdapter = {
  id: "fake-renderer",
  supports: () => ({ supported: true, reasons: [] }),
  async render(ir, opts) {
    const filePath = join(opts.workDir, "out.mp4");
    await writeFile(filePath, `fake-mp4:${ir.title}`);
    return {
      filePath,
      mime: "video/mp4",
      probe: {
        durationMs: ir.format.durationMs,
        width: 540,
        height: 960,
        fps: 30,
        videoCodec: "h264",
        bytes: 0,
      },
    };
  },
};

interface WorkerOptions {
  /** Called after the paid brief decision, before the plan stage returns (the place the worker dies). */
  brandLookup?: BrandLookup;
  /** Heartbeats never resolve: nothing on this worker notices its lease running out. */
  frozen?: boolean;
  /** Wrap the fenced queue, e.g. to fail one stage write. */
  wrapQueue?: (queue: WorkerJobQueue) => WorkerJobQueue;
}

/** A worker process: its own decision router over a fake paid model, writing provider executions to Postgres. */
function createWorker(workerId: string, options: WorkerOptions = {}) {
  const { repos } = db.current;
  const model = new FakeDecisionAdapter({
    id: "openrouter",
    fallback: {
      output: { brandName: "Sương Mai", keyMessages: ["Rang mới mỗi tuần"] },
      costCents: DECISION_CENTS,
    },
  });
  const router = new DecisionRouter({
    providers: [model, registerBriefRule(new RulesAdapter({ logger }))],
    routes: { [VIDEO_BRIEF_DECISION]: ["openrouter", "rules"] },
    sink: createExecutionSink(repos.usage),
    logger,
  });
  const base = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
  const fenced = options.wrapQueue ? options.wrapQueue(base) : base;
  const queue: WorkerJobQueue = options.frozen
    ? { ...fenced, heartbeat: () => new Promise<HeartbeatResult>(() => {}) }
    : fenced;
  const executor = createJobExecutor({
    queue,
    jobs: repos.jobs,
    approvals: repos.approvals,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    approvalTtlMs: 3_600_000,
    billing: createJobBudgetPolicy(),
    ledger: createUsageLedger(repos.usage),
    clock: { now: () => new Date() },
    logger,
    heartbeatIntervalMs: 50,
    retryBackoff: { baseMs: 10, maxMs: 50 },
    workflows: [
      createVideoCreateWorkflow({
        planner: createVideoPlanner({ decisions: router, brandLookup: options.brandLookup, logger }),
        renderer,
        storage,
        projects: repos.projects,
        renders: repos.renders,
        workRoot: mkdtempSync(join(tmpdir(), "studix-paid-resume-")),
        renderCentsPerSecond: 1,
      }),
    ],
  });
  const shutdown = new AbortController();
  return {
    model,
    queue: base,
    async runOnce() {
      const job = await base.claim(workerId);
      if (!job) return undefined;
      return { job, outcome: await executor.execute(job, workerId, shutdown.signal) };
    },
  };
}

async function waitFor<T>(check: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

async function enqueue(slug: string) {
  const { repos } = db.current;
  const { organization, workspace } = await repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  const ctx: TenantContext = {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_1", role: "owner" },
  };
  const project = await repos.projects.create(ctx, {
    title: "Sương Mai",
    status: "draft",
    // Prompt-only brief: the plan stage pays for one brief decision.
    brief: { prompt: "Giới thiệu thương hiệu cà phê Sương Mai, video dọc 9:16" },
    createdBy: actor,
  });
  const { job } = await repos.queue.enqueue(ctx, {
    kind: "video.create",
    projectId: project.id,
    payload: { projectId: project.id, renderPreset: "preview" },
    createdBy: actor,
    budgetCents: 500,
    maxAttempts: 3,
  });
  return { ctx, job };
}

async function ledgerOf(ctx: TenantContext, jobId: string) {
  const { repos } = db.current;
  const usage = (await repos.usage.list(ctx, { jobId, limit: 100 })).items;
  const executions = (await repos.usage.listProviderExecutions(ctx, { jobId })).items;
  return { usage, executions };
}

describe("paid stage resume", () => {
  it("bills each provider call once and records every attempt's call when a worker dies mid-stage", async () => {
    const { ctx, job } = await enqueue("paid-kill");
    const { repos } = db.current;

    // Worker A pays for the brief decision, then dies inside the plan stage before it reports usage.
    let wake!: () => void;
    const revived = new Promise<void>((resolve) => {
      wake = resolve;
    });
    let reachedLookup!: () => void;
    const inLookup = new Promise<void>((resolve) => {
      reachedLookup = resolve;
    });
    const a = createWorker("worker-a", {
      frozen: true,
      brandLookup: async () => {
        reachedLookup();
        await revived;
        return undefined;
      },
    });
    const aRun = a.runOnce();
    await inLookup;
    expect(a.model.invocations).toHaveLength(1);

    // A's lease lapses; worker B (a new process, so no shared decision cache) resumes the job.
    expect(await createWorker("probe").queue.claim("probe")).toBeUndefined();
    await repos.jobs.update(ctx, job.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    const b = createWorker("worker-b");
    const resumed = await waitFor(() => b.runOnce());
    expect(resumed).toMatchObject({ outcome: "succeeded", job: { attempts: 2 } });
    expect(b.model.invocations).toHaveLength(1);

    // A wakes after B finished: its late usage line for attempt 1 is fenced out.
    wake();
    expect((await aRun)?.outcome).toBe("lease_lost");

    const { usage, executions } = await ledgerOf(ctx, job.id);
    // One provider execution per attempt that called the model: A's (attempt 1) and B's (attempt 2).
    const decisions = executions.filter((e) => e.operation === `decision.${VIDEO_BRIEF_DECISION}`);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((e) => e.provider === "openrouter" && e.status === "succeeded")).toBe(true);
    expect(new Set(decisions.map((e) => e.id)).size).toBe(2);
    expect(decisions.every((e) => e.costCents === DECISION_CENTS)).toBe(true);

    // No usage dedupe key twice, and the decision usage points at the execution that produced it.
    expect(new Set(usage.map((u) => u.dedupeKey)).size).toBe(usage.length);
    const decisionUsage = usage.filter((u) => u.kind === USAGE_KINDS.providerDecision);
    expect(decisionUsage).toHaveLength(1);
    expect(decisionUsage[0]).toMatchObject({ costCents: DECISION_CENTS, metadata: { attempt: 2 } });
    expect(decisions.map((e) => e.id)).toContain(decisionUsage[0]?.providerExecutionId);
    expect(usage.filter((u) => u.kind === USAGE_KINDS.renderSeconds)).toHaveLength(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("bills a decision once when the plan stage retries in the same process after its usage was recorded", async () => {
    const { ctx, job } = await enqueue("paid-retry");
    // The plan checkpoint write fails once after the usage line landed; the retry replays the cached decision.
    let failures = 1;
    const worker = createWorker("worker-retry", {
      wrapQueue: (queue) => ({
        ...queue,
        writeStage: async (j, workerId, stage) => {
          if (stage.name === "plan" && stage.status === "succeeded" && failures-- > 0)
            throw new StudixError("UNAVAILABLE", "checkpoint store temporarily unavailable");
          return queue.writeStage(j, workerId, stage);
        },
      }),
    });
    expect((await worker.runOnce())?.outcome).toBe("retrying");
    expect((await waitFor(() => worker.runOnce()))?.outcome).toBe("succeeded");
    expect(worker.model.invocations).toHaveLength(1);

    const { usage, executions } = await ledgerOf(ctx, job.id);
    expect(executions.filter((e) => e.operation === `decision.${VIDEO_BRIEF_DECISION}`)).toHaveLength(1);
    expect(new Set(usage.map((u) => u.dedupeKey)).size).toBe(usage.length);
    const decisionUsage = usage.filter((u) => u.kind === USAGE_KINDS.providerDecision);
    expect(decisionUsage).toHaveLength(1);
    expect(decisionUsage[0]).toMatchObject({
      costCents: DECISION_CENTS,
      providerExecutionId: executions[0]?.id,
    });
  });
});
