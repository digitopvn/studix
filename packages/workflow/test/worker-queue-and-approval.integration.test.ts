import type { Job, TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { describe, expect, it } from "vitest";
import { createWorkerJobQueue, createWorkerPool, type JobOutcome } from "../src/index.ts";
import {
  createTestWorker,
  enqueueCreate,
  fakePublisher,
  fakeRenderer,
  fixtureIr,
  silentLogger,
  tenant,
  waitFor,
} from "./workflow-test-harness.ts";

const db = withTestDatabase();
const human = { type: "user" as const, id: "usr_reviewer" };

/** A finished render plus a video.publish job for it. */
async function enqueuePublish(ctx: TenantContext): Promise<Job> {
  const { repos } = db.current;
  const project = await repos.projects.create(ctx, {
    title: "Publish me",
    status: "in_review",
    brief: { prompt: "intro" },
    createdBy: human,
  });
  const version = await repos.projects.createVersion(ctx, {
    projectId: project.id,
    ir: fixtureIr,
    source: "client",
    createdBy: human,
  });
  const render = await repos.renders.create(ctx, {
    projectId: project.id,
    versionId: version.id,
    preset: "final",
    spec: { preset: "final", container: "mp4", videoCodec: "h264", audioCodec: "aac", scale: 1, crf: 18 },
    status: "succeeded",
    storageKey: "renders/x/final.mp4",
  });
  const { job } = await repos.queue.enqueue(ctx, {
    kind: "video.publish",
    projectId: project.id,
    payload: { renderId: render.id, title: "Launch" },
    createdBy: human,
  });
  return job;
}

describe("worker queue", () => {
  it("never lets concurrent workers claim the same job", async () => {
    const ctx = await tenant(db.current, "concurrent");
    for (let i = 0; i < 30; i++) {
      await db.current.repos.queue.enqueue(ctx, { kind: "noop", payload: {}, createdBy: human });
    }
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    const claimed: string[] = [];
    await Promise.all(
      Array.from({ length: 6 }, async (_, w) => {
        for (;;) {
          const job = await queue.claim(`w${w}`);
          if (!job) return;
          claimed.push(job.id);
        }
      }),
    );
    expect(claimed).toHaveLength(30);
    expect(new Set(claimed).size).toBe(30);
    // Leave nothing claimable behind for the next tests.
    for (const id of claimed) await db.current.repos.jobs.update(ctx, id, { status: "succeeded" });
  });

  it("releases the running job on graceful shutdown without consuming the attempt", async () => {
    const ctx = await tenant(db.current, "shutdown");
    const { job } = await enqueueCreate(db.current, ctx);
    const worker = createTestWorker(db.current, "pool", {
      renderer: fakeRenderer({ hold: "forever" }).renderer,
    });
    const outcomes: JobOutcome[] = [];
    const pool = createWorkerPool({
      queue: worker.queue,
      executor: worker.executor,
      workerId: "pool",
      concurrency: 2,
      logger: silentLogger,
      pollIntervalMs: 20,
      onOutcome: (_id, outcome) => outcomes.push(outcome),
    });
    pool.start();
    await waitFor(async () => (await db.current.repos.jobs.get(ctx, job.id))?.stage === "render");
    expect(pool.status()).toMatchObject({ running: true, activeJobs: 1 });
    await pool.stop(100);
    expect(outcomes).toEqual(["released"]);
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(pool.status()).toMatchObject({ running: false, activeJobs: 0 });
    await db.current.repos.queue.cancel(ctx, job.id);
  });
});

describe("publish approval gate", () => {
  it("blocks publishing until a human approves, across a worker restart", async () => {
    const ctx = await tenant(db.current, "publish");
    const job = await enqueuePublish(ctx);
    const pub = fakePublisher();

    const first = createTestWorker(db.current, "w1", { publisher: pub.publisher });
    expect((await first.runOnce())?.outcome).toBe("waiting_approval");
    expect(pub.calls).toHaveLength(0);
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "waiting_approval",
      attempts: 0,
    });
    const pending = (await db.current.repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "publish",
    ))!;
    expect(pending).toMatchObject({ status: "pending", requestedBy: { type: "system" } });
    expect(await first.queue.resumeDecidedApprovals()).toBe(0);
    expect(await first.runOnce()).toBeUndefined();

    await db.current.repos.approvals.decide(ctx, pending.id, {
      status: "approved",
      decidedBy: human,
      decidedAt: new Date(),
    });

    // A fresh worker (restart) reads the approval from the database.
    const restarted = createTestWorker(db.current, "w2", { publisher: pub.publisher });
    expect(await restarted.queue.resumeDecidedApprovals()).toBe(1);
    expect((await restarted.runOnce())?.outcome).toBe("succeeded");
    expect(pub.calls).toEqual([
      { approvalId: pending.id, renderId: (job.payload as { renderId: string }).renderId },
    ]);
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "succeeded",
      result: { platform: "fake", externalId: "ext-1", approvalId: pending.id },
    });
  });

  it("does not accept an approval granted by a non-human actor", async () => {
    const ctx = await tenant(db.current, "publish-key");
    const job = await enqueuePublish(ctx);
    const pub = fakePublisher();
    const worker = createTestWorker(db.current, "w", { publisher: pub.publisher });
    await worker.runOnce();
    const pending = (await db.current.repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "publish",
    ))!;
    await db.current.repos.approvals.decide(ctx, pending.id, {
      status: "approved",
      decidedBy: { type: "apiKey", id: "key_1" },
      decidedAt: new Date(),
    });
    expect(await worker.queue.resumeDecidedApprovals()).toBe(0);

    // Even if the job is requeued by hand, the gate re-reads the approval and refuses to publish.
    await db.current.repos.queue.resume(ctx, job.id);
    expect((await worker.runOnce())?.outcome).toBe("waiting_approval");
    expect(pub.calls).toHaveLength(0);
    await db.current.repos.queue.cancel(ctx, job.id);
  });

  it("fails the job when the reviewer rejects publishing", async () => {
    const ctx = await tenant(db.current, "publish-reject");
    const job = await enqueuePublish(ctx);
    const pub = fakePublisher();
    const worker = createTestWorker(db.current, "w", { publisher: pub.publisher });
    await worker.runOnce();
    const pending = (await db.current.repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "publish",
    ))!;
    await db.current.repos.approvals.decide(ctx, pending.id, {
      status: "rejected",
      decidedBy: human,
      decidedAt: new Date(),
      comment: "no",
    });
    expect(await worker.queue.resumeDecidedApprovals()).toBe(1);
    expect((await worker.runOnce())?.outcome).toBe("failed");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN" },
    });
    expect(pub.calls).toHaveLength(0);
  });
});
