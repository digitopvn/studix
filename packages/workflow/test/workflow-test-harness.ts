import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobBudgetPolicy, createPostgresUsageLedger } from "@studix/billing";
import {
  createDefaultApprovalPolicy,
  type ProjectRepository,
  type PublisherAdapter,
  type RendererAdapter,
  type RenderRepository,
  type StorageAdapter,
  type TenantContext,
} from "@studix/core";
import type { TestDatabase } from "@studix/database/testing";
import { createLogger, StudixError } from "@studix/shared";
import { unwrapValidation, type VideoIR, validateVideoIR } from "@studix/video-ir";
import {
  createJobExecutor,
  createVideoCreateWorkflow,
  createVideoPublishWorkflow,
  createWorkerJobQueue,
  type HeartbeatResult,
  type Planner,
} from "../src/index.ts";

export const fixtureIr: VideoIR = unwrapValidation(
  validateVideoIR(
    JSON.parse(
      readFileSync(new URL("../../video-ir/fixtures/brand-intro-9x16.json", import.meta.url), "utf8"),
    ),
  ),
  "fixture",
);

export const silentLogger = createLogger({}, { level: "error", write: () => {} });

export async function tenant(db: TestDatabase, slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_1", role: "owner" },
  };
}

/** Wait until `check` returns a truthy value (polling real time). */
export async function waitFor<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

export function fakePlanner(options: { costCents?: number } = {}) {
  const state = { calls: 0 };
  const planner: Planner = async () => {
    state.calls++;
    return {
      ir: fixtureIr,
      usage: [{ provider: "fake", model: "fake-1", costCents: options.costCents ?? 1.5 }],
    };
  };
  return { planner, state };
}

/** Writes a small fake MP4. `hold` makes render wait until aborted (or forever when it ignores the signal). */
export function fakeRenderer(
  options: {
    hold?: "until-abort" | "forever";
    supported?: boolean;
    /** Once settled, the render fails with a non-retryable error (a browser killed under it). */
    crash?: Promise<void>;
  } = {},
) {
  const state: { calls: number; deadlineAt?: Date } = { calls: 0 };
  const renderer: RendererAdapter = {
    id: "fake-renderer",
    supports: () =>
      options.supported === false
        ? { supported: false, reasons: ["nope"] }
        : { supported: true, reasons: [] },
    async render(ir, opts) {
      state.calls++;
      state.deadlineAt = opts.deadlineAt;
      opts.onProgress?.({ progress: 0.5, phase: "frames" });
      if (options.crash) {
        await options.crash;
        throw new StudixError("INTERNAL", "Browser closed during render", { retryable: false });
      }
      if (options.hold === "forever") await new Promise(() => {});
      if (options.hold === "until-abort") {
        await new Promise((_, reject) =>
          opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason)),
        );
      }
      const filePath = join(opts.workDir, "out.mp4");
      await writeFile(filePath, Buffer.from(`fake-mp4:${ir.title}`));
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
  return { renderer, state };
}

/** In-memory tenant-scoped storage; `failPuts` makes the first N puts fail with a retryable error. */
export function fakeStorage(options: { failPuts?: number } = {}) {
  const objects = new Map<string, Uint8Array>();
  let failures = options.failPuts ?? 0;
  const full = (ctx: TenantContext, key: string) => `${ctx.workspaceId}/${key}`;
  const storage: StorageAdapter = {
    async put(ctx, key, body, opts) {
      if (failures > 0) {
        failures--;
        throw new StudixError("UNAVAILABLE", "storage temporarily unavailable");
      }
      if (!("filePath" in body)) throw new Error("fake storage only accepts files");
      const bytes = await readFile(body.filePath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (opts.sha256 && opts.sha256 !== sha256) throw new StudixError("VALIDATION", "sha mismatch");
      objects.set(full(ctx, key), bytes);
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
    delete: async (ctx, key) => {
      objects.delete(full(ctx, key));
    },
  };
  return { storage, objects };
}

export function fakePublisher() {
  const calls: Array<{ approvalId: string; renderId: string }> = [];
  const publisher: PublisherAdapter = {
    id: "fake-publisher",
    platform: "fake",
    async publish(_ctx, request) {
      calls.push({ approvalId: request.approvalId, renderId: request.renderId });
      return { platform: "fake", externalId: `ext-${calls.length}` };
    },
  };
  return { publisher, calls };
}

export interface WorkerOptions {
  planner?: Planner;
  renderer?: RendererAdapter;
  storage?: StorageAdapter;
  publisher?: PublisherAdapter;
  /** Read-side project repository the workflow sees (stage writes always go through the fenced commit). */
  projects?: Pick<ProjectRepository, "get" | "getVersion">;
  renders?: Pick<RenderRepository, "get">;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  /** "hang": heartbeats never resolve, like a worker whose database connection froze. */
  heartbeat?: "hang";
  renderCentsPerSecond?: number;
}

/** One simulated worker process over the test database. */
export function createTestWorker(db: TestDatabase, workerId: string, options: WorkerOptions = {}) {
  const { repos } = db;
  const queue = createWorkerJobQueue(db.db, { leaseMs: options.leaseMs ?? 30_000 });
  const executor = createJobExecutor({
    queue:
      options.heartbeat === "hang"
        ? { ...queue, heartbeat: () => new Promise<HeartbeatResult>(() => {}) }
        : queue,
    jobs: repos.jobs,
    approvals: repos.approvals,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    approvalTtlMs: 3_600_000,
    billing: createJobBudgetPolicy(),
    ledger: createPostgresUsageLedger(db.db),
    clock: { now: () => new Date() },
    logger: silentLogger,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 50,
    retryBackoff: { baseMs: 10, maxMs: 50 },
    workflows: [
      createVideoCreateWorkflow({
        planner: options.planner ?? fakePlanner().planner,
        renderer: options.renderer ?? fakeRenderer().renderer,
        storage: options.storage ?? fakeStorage().storage,
        projects: options.projects ?? repos.projects,
        renders: options.renders ?? repos.renders,
        workRoot: mkdtempSync(join(tmpdir(), "studix-worker-test-")),
        renderCentsPerSecond: options.renderCentsPerSecond,
      }),
      createVideoPublishWorkflow({ renders: repos.renders, publisher: options.publisher }),
    ],
  });
  const shutdown = new AbortController();
  return {
    queue,
    executor,
    shutdown,
    /** Claim one job and run it to its outcome. */
    async runOnce() {
      const job = await queue.claim(workerId);
      if (!job) return undefined;
      return { job, outcome: await executor.execute(job, workerId, shutdown.signal) };
    },
  };
}

/** Project with a brief, plus an enqueued video.create job. */
export async function enqueueCreate(
  db: TestDatabase,
  ctx: TenantContext,
  extra: { budgetCents?: number; deadlineAt?: Date; maxAttempts?: number; idempotencyKey?: string } = {},
) {
  const project = await db.repos.projects.create(ctx, {
    title: "Coffee intro",
    status: "draft",
    brief: { prompt: "Video giới thiệu thương hiệu cà phê 15 giây" },
    createdBy: { type: "user", id: "usr_1" },
  });
  const { job, created } = await db.repos.queue.enqueue(ctx, {
    kind: "video.create",
    projectId: project.id,
    payload: { projectId: project.id, renderPreset: "preview" },
    createdBy: { type: "user", id: "usr_1" },
    budgetCents: extra.budgetCents ?? 500,
    deadlineAt: extra.deadlineAt,
    maxAttempts: extra.maxAttempts ?? 3,
    idempotencyKey: extra.idempotencyKey,
  });
  return { project, job, created };
}
