import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { MultixProvider, type MultixRunner, type MultixRunResult } from "@studix/providers";
import { createLogger, StudixError } from "@studix/shared";
import { MV_STAGES, packPipelines, packRegistry } from "@studix/skills";
import {
  createJobExecutor,
  createVideoCreateWorkflow,
  createWorkerJobQueue,
  type HeartbeatResult,
  type WorkerJobQueue,
} from "@studix/workflow";
import { describe, expect, it } from "vitest";

const db = withTestDatabase();
const logger = createLogger({}, { level: "error", write: () => {} });
const actor = { type: "user", id: "usr_1" } as const;

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

/** The storyboard never renders; the pipeline only checks the renderer id. */
const renderer: RendererAdapter = {
  id: "hyperframes",
  supports: () => ({ supported: true, reasons: [] }),
  render: async () => {
    throw new Error("the storyboard does not render");
  },
};

const flagValue = (argv: readonly string[], name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/**
 * One worker's multix CLI. Submits share one upstream counter (the same Sume account); `collect` decides how
 * `sume status --wait` answers on this worker: hang until released (the worker froze) or deliver the frame.
 */
function sumeCli(upstream: { submits: string[] }, collect: "hang" | "deliver") {
  const statuses: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reply = (envelope: Record<string, unknown>, exitCode = 0): MultixRunResult => ({
    exitCode,
    stdout: `${JSON.stringify({ schema: "multix.result/v1", ok: exitCode === 0, ...envelope })}\n`,
  });
  const runner: MultixRunner = async (argv) => {
    if (argv[0] === "sume" && argv[1] === "image" && argv.includes("--estimate")) {
      return reply({
        estimate: { status: "estimated", high_usd: 0.01 },
        cost: { actual_source: "no_request" },
      });
    }
    if (argv[0] === "sume" && argv[1] === "image") {
      const id = `job_${upstream.submits.length + 1}`;
      upstream.submits.push(id);
      return reply({ job: { provider: "sume", id }, text: `Job submitted: ${id}` });
    }
    if (argv[0] === "sume" && argv[1] === "status") {
      const id = argv[2] as string;
      statuses.push(id);
      if (collect === "hang") {
        await released;
        return { exitCode: 143, stdout: "", stoppedBy: "timeout" };
      }
      const dir = flagValue(argv, "output") as string;
      await mkdir(dir, { recursive: true });
      const out = join(dir, `${id}.png`);
      await writeFile(out, `png:${id}`);
      return reply({
        outputs: [{ path: out, mime: "image/png", width: 768, height: 1344 }],
        usage: { metrics: { "data.job.usage_summary.captured_usd_cents": 1 } },
        cost: { actual_usd: 0.01, actual_source: "provider" },
      });
    }
    throw new Error(`unexpected multix argv ${argv.join(" ")}`);
  };
  return { runner, statuses, release };
}

/** A worker process with its own Multix provider (and so its own empty in-process journal). */
function createWorker(
  workerId: string,
  cli: ReturnType<typeof sumeCli>,
  options: { frozen?: boolean; storage?: StorageAdapter } = {},
) {
  const { repos } = db.current;
  const base = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
  const queue: WorkerJobQueue = options.frozen
    ? { ...base, heartbeat: () => new Promise<HeartbeatResult>(() => {}) }
    : base;
  const workRoot = mkdtempSync(join(tmpdir(), "studix-pack-resume-"));
  const media = new MultixProvider({ bin: "multix", runner: cli.runner, env: {} });
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
    services: { media, storage: options.storage ?? storage, renderer, workRoot },
    workflows: [
      createVideoCreateWorkflow({
        planner: async () => {
          throw new Error("pack pipelines do not plan");
        },
        renderer,
        storage: options.storage ?? storage,
        projects: repos.projects,
        renders: repos.renders,
        workRoot,
        pipelines: packPipelines(packRegistry),
      }),
    ],
  });
  const shutdown = new AbortController();
  return {
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
    title: "Lá Mây",
    status: "draft",
    // One direction with a hook and a CTA: two storyboard frames.
    brief: {
      prompt: "Quảng cáo dọc 20 giây cho tiệm trà Lá Mây",
      language: "vi",
      aspectRatio: "9:16",
      durationMs: 20_000,
      directions: [{ id: "sang-som", name: "Buổi sáng", concept: "Tách trà nóng mở đầu ngày mới." }],
    },
    workflowTemplate: "marketing-video",
    createdBy: actor,
  });
  const { job } = await repos.queue.enqueue(ctx, {
    kind: "video.create",
    projectId: project.id,
    payload: { projectId: project.id, renderPreset: "preview", workflowTemplate: "marketing-video" },
    createdBy: actor,
    budgetCents: 500,
    maxAttempts: 3,
  });
  return { ctx, job, project };
}

describe("pack media resume", () => {
  it("resumes the storyboard's submitted frames by job id after a worker dies, never submitting or billing twice", async () => {
    const { ctx, job, project } = await enqueue("pack-media-kill");
    const { repos } = db.current;
    const upstream = { submits: [] as string[] };

    // Worker A submits both frames, then freezes while waiting on them: no heartbeat, no collect.
    const cliA = sumeCli(upstream, "hang");
    const a = createWorker("worker-a", cliA, { frozen: true });
    const aRun = a.runOnce();
    await waitFor(async () => cliA.statuses.length === 2);
    expect(upstream.submits).toEqual(["job_1", "job_2"]);

    // The submitted jobs are on the storyboard stage row, so they outlive worker A's process.
    const rows = await repos.jobs.listStages(ctx, job.id);
    const storyboard = rows.find((r) => r.name === MV_STAGES.storyboard);
    expect(storyboard?.mediaJobs?.map((r) => [r.state, r.job?.id]).sort()).toEqual([
      ["submitted", "job_1"],
      ["submitted", "job_2"],
    ]);

    // A's lease lapses; worker B (a new process with an empty provider journal) resumes the same jobs.
    await repos.jobs.update(ctx, job.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    const cliB = sumeCli(upstream, "deliver");
    const b = createWorker("worker-b", cliB);
    const resumed = await waitFor(() => b.runOnce());
    expect(resumed).toMatchObject({ outcome: "succeeded", job: { attempts: 2 } });
    expect(upstream.submits).toEqual(["job_1", "job_2"]);
    expect(cliB.statuses.sort()).toEqual(["job_1", "job_2"]);

    // A wakes after B finished; whatever it does next is fenced out.
    cliA.release();
    expect((await aRun)?.outcome).toBe("lease_lost");

    const usage = (await repos.usage.list(ctx, { jobId: job.id, limit: 100 })).items;
    expect(new Set(usage.map((u) => u.dedupeKey)).size).toBe(usage.length);
    const frames = usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration);
    expect(frames).toHaveLength(2);
    // Sume's captured amount is the receipt, one line per upstream job.
    expect(frames.every((u) => u.costCents === 1)).toBe(true);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await repos.projects.get(ctx, project.id)).toMatchObject({ status: "in_review" });
  });

  it("requeues a failed job so the resumed stage collects the frames it already paid for", async () => {
    const { ctx, job, project } = await enqueue("pack-media-retry");
    const { repos } = db.current;
    const upstream = { submits: [] as string[] };

    // The frames are generated and billed, then storage refuses them for good (a missing bucket).
    const brokenStorage: StorageAdapter = {
      ...storage,
      put: async () => {
        throw new StudixError("UNAVAILABLE", "bucket is missing", { retryable: false });
      },
    };
    const failing = createWorker("worker-a", sumeCli(upstream, "deliver"), { storage: brokenStorage });
    expect((await failing.runOnce())?.outcome).toBe("failed");
    expect(upstream.submits).toEqual(["job_1", "job_2"]);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "failed" });
    await expect(repos.queue.retryFailed(ctx, project.id, { maxAttempts: 3 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // The cause is fixed; the same job is requeued and a fresh worker finishes it.
    const requeued = await repos.queue.retryFailed(ctx, job.id, { maxAttempts: 3 });
    expect(requeued).toMatchObject({ status: "queued", cancelRequested: false, maxAttempts: 4 });
    expect(requeued.error).toBeUndefined();
    await expect(repos.queue.retryFailed(ctx, job.id, { maxAttempts: 3 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const cliB = sumeCli(upstream, "deliver");
    const resumed = await waitFor(() => createWorker("worker-b", cliB).runOnce());
    expect(resumed).toMatchObject({ outcome: "succeeded", job: { attempts: 2 } });
    expect(upstream.submits).toEqual(["job_1", "job_2"]);

    const usage = (await repos.usage.list(ctx, { jobId: job.id, limit: 100 })).items;
    expect(new Set(usage.map((u) => u.dedupeKey)).size).toBe(usage.length);
    expect(usage.filter((u) => u.kind === USAGE_KINDS.mediaGeneration)).toHaveLength(2);
    expect(await repos.projects.get(ctx, project.id)).toMatchObject({ status: "in_review" });
  });
});
