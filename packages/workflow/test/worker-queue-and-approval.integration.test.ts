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

  it("measures leases on the database clock, whatever the worker clocks say", async () => {
    const ctx = await tenant(db.current, "clock-skew");
    const { job } = await enqueueCreate(db.current, ctx);
    const hourMs = 3_600_000;
    const withSkew = (offsetMs: number) =>
      createWorkerJobQueue(db.current.db, {
        leaseMs: 30_000,
        clock: { now: () => new Date(Date.now() + offsetMs) },
      });
    const accurate = withSkew(0);
    const claimed = (await accurate.claim("w-owner"))!;
    expect(claimed.id).toBe(job.id);
    // The lease runs 30s from the database's now.
    expect(Math.abs(claimed.leaseExpiresAt!.getTime() - (Date.now() + 30_000))).toBeLessThan(5_000);

    // A worker whose clock runs an hour ahead cannot take a lease that is still valid on the database.
    expect(await withSkew(hourMs).claim("w-ahead")).toBeUndefined();
    // An owner whose clock runs an hour behind still gets a lease measured from the database's now.
    const renewed = await withSkew(-hourMs).heartbeat(claimed, "w-owner");
    expect(renewed.held).toBe(true);
    expect(Math.abs(renewed.leaseExpiresAt!.getTime() - (Date.now() + 30_000))).toBeLessThan(5_000);

    await db.current.repos.jobs.update(ctx, job.id, { status: "succeeded" });
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
  it("releases a job whose render fails while the pool drains instead of failing it", async () => {
    const ctx = await tenant(db.current, "drain-crash");
    const { job } = await enqueueCreate(db.current, ctx);
    let crash!: () => void;
    const crashed = new Promise<void>((resolve) => {
      crash = resolve;
    });
    const worker = createTestWorker(db.current, "drain", {
      renderer: fakeRenderer({ crash: crashed }).renderer,
    });
    const outcomes: JobOutcome[] = [];
    const pool = createWorkerPool({
      queue: worker.queue,
      executor: worker.executor,
      workerId: "drain",
      concurrency: 1,
      logger: silentLogger,
      pollIntervalMs: 20,
      onOutcome: (_id, outcome) => outcomes.push(outcome),
    });
    pool.start();
    await waitFor(async () => (await db.current.repos.jobs.get(ctx, job.id))?.stage === "render");
    const stopped = pool.stop(5_000);
    crash();
    await stopped;
    expect(outcomes).toEqual(["released"]);
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({ status: "queued", attempts: 0 });
    await db.current.repos.queue.cancel(ctx, job.id);
  });
});

describe("fenced attempt writes", () => {
  it("ignores stage, progress and spend writes from a worker that lost the job", async () => {
    const ctx = await tenant(db.current, "fenced");
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    const stale = await queue.claim("stalled");
    expect(stale?.id).toBe(job.id);
    const usage = (dedupeKey: string) => ({
      dedupeKey,
      kind: "render",
      quantity: 1,
      unit: "s",
      costCents: 7,
      jobId: job.id,
    });

    // The stalled worker still owns the job: its writes land.
    expect(await queue.updateProgress(stale!, "stalled", { stage: "plan", progress: 0.1 })).toBe(true);
    expect(await queue.writeStage(stale!, "stalled", { name: "plan", status: "running" })).toBe(true);
    expect(await queue.recordUsage(stale!, "stalled", usage("own"))).toBe(true);

    // Its lease lapses and another worker reclaims the job at the next attempt.
    await repos.jobs.update(ctx, job.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    const fresh = await queue.claim("fresh");
    expect(fresh).toMatchObject({ id: job.id, attempts: stale!.attempts + 1 });

    expect(await queue.updateProgress(stale!, "stalled", { stage: "old", spentCents: 999 })).toBe(false);
    expect(await queue.writeStage(stale!, "stalled", { name: "plan", status: "succeeded" })).toBe(false);
    expect(await queue.recordUsage(stale!, "stalled", usage("late"))).toBe(false);
    // Right worker id but the previous attempt number is fenced out as well.
    expect(await queue.writeStage(stale!, "fresh", { name: "plan", status: "failed" })).toBe(false);

    const after = await repos.jobs.get(ctx, job.id);
    expect(after).toMatchObject({ stage: "plan", spentCents: 0, lockedBy: "fresh" });
    const stages = await repos.jobs.listStages(ctx, job.id);
    expect(stages.map((s) => [s.attempt, s.status])).toEqual([[stale!.attempts, "failed"]]);
    expect((await db.current.repos.usage.list(ctx, { jobId: job.id })).items.map((u) => u.dedupeKey)).toEqual(
      ["own"],
    );

    // The current owner writes normally.
    expect(await queue.writeStage(fresh!, "fresh", { name: "plan", status: "succeeded" })).toBe(true);
    expect(await queue.recordUsage(fresh!, "fresh", usage("current"))).toBe(true);
    await repos.queue.cancel(ctx, job.id);
  });

  it("opens an approval and its audit entry only for the current owner, and reuses a live request", async () => {
    const ctx = await tenant(db.current, "fenced-approval");
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    const subject = { type: "job" as const, id: job.id };
    const request = { action: "publish" as const, reason: "needs review", ttlMs: 60_000 };
    const audits = async () =>
      (await repos.audit.list(ctx, { subjectType: "job", subjectId: job.id })).items.filter(
        (e) => e.action === "approval.requested",
      );
    const stale = await queue.claim("stalled");
    await repos.jobs.update(ctx, job.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    const fresh = await queue.claim("fresh");

    // The stalled worker (old attempt, and old worker id) opens nothing.
    expect(await queue.requestApproval(stale!, "stalled", request)).toEqual({ status: "lost" });
    expect(await queue.requestApproval(stale!, "fresh", request)).toEqual({ status: "lost" });
    expect(await repos.approvals.findLatest(ctx, subject, "publish")).toBeUndefined();
    expect(await audits()).toHaveLength(0);

    // Concurrent requests from the owner collapse into one approval and one audit entry.
    const results = await Promise.all([
      queue.requestApproval(fresh!, "fresh", request),
      queue.requestApproval(fresh!, "fresh", request),
      queue.requestApproval(fresh!, "fresh", request),
    ]);
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.status === "existing")).toHaveLength(2);
    const { items } = await repos.approvals.list(ctx, { subject });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "pending", requestedBy: { type: "system", id: "fresh" } });
    expect(await audits()).toHaveLength(1);

    // A decision that lands after the caller last looked is returned, not shadowed by a new request.
    await repos.approvals.decide(ctx, items[0]!.id, {
      status: "rejected",
      decidedBy: human,
      decidedAt: new Date(),
    });
    expect(await queue.requestApproval(fresh!, "fresh", request)).toMatchObject({
      status: "decided",
      approval: { id: items[0]!.id, status: "rejected" },
    });
    expect((await repos.approvals.list(ctx, { subject })).items).toHaveLength(1);

    // Once the job is finished, a late request leaves no orphan behind.
    await queue.complete(fresh!, "fresh", {});
    expect(await queue.requestApproval(fresh!, "fresh", { ...request, action: "render.final" })).toEqual({
      status: "lost",
    });
    expect((await repos.approvals.list(ctx, { subject })).items).toHaveLength(1);
  });
});

describe("fenced business commits", () => {
  it("applies project writes only for the current owner and rolls back on error", async () => {
    const ctx = await tenant(db.current, "commit");
    const { repos } = db.current;
    const { project, job } = await enqueueCreate(db.current, ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    const stale = (await queue.claim("stalled"))!;

    const owned = await queue.commit(stale, "stalled", (r, c) =>
      r.projects.update(c, project.id, { status: "rendering" }),
    );
    expect(owned).toMatchObject({ held: true, value: { status: "rendering" } });

    // An error inside the commit undoes every write made in it.
    await expect(
      queue.commit(stale, "stalled", async (r, c) => {
        await r.projects.update(c, project.id, { status: "failed" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await repos.projects.get(ctx, project.id))?.status).toBe("rendering");

    await repos.jobs.update(ctx, job.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    const fresh = (await queue.claim("fresh"))!;
    for (const [held, worker] of [
      [stale, "stalled"],
      [stale, "fresh"], // right worker id, previous attempt
    ] as const) {
      const late = await queue.commit(held, worker, (r, c) =>
        r.projects.update(c, project.id, { status: "in_review" }),
      );
      expect(late).toEqual({ held: false });
    }
    expect((await repos.projects.get(ctx, project.id))?.status).toBe("rendering");

    const current = await queue.commit(fresh, "fresh", (r, c) =>
      r.projects.update(c, project.id, { status: "in_review" }),
    );
    expect(current).toMatchObject({ held: true });
    expect((await repos.projects.get(ctx, project.id))?.status).toBe("in_review");
    await repos.queue.cancel(ctx, job.id);
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
