import type { Job, TenantContext } from "@studix/core";
import { schema } from "@studix/database";
import { withTestDatabase } from "@studix/database/testing";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerJobQueue } from "../src/index.ts";
import { tenant } from "./workflow-test-harness.ts";

const db = withTestDatabase();
const human = { type: "user" as const, id: "usr_reviewer" };
const system = { type: "system" as const, id: "studio" };

const enqueued: Array<{ ctx: TenantContext; id: string }> = [];

/** Queued jobs are claimable by any worker, so leave none behind for the tests that claim. */
afterEach(async () => {
  for (const { ctx, id } of enqueued.splice(0)) await db.current.repos.queue.cancel(ctx, id);
});

async function enqueueJob(ctx: TenantContext): Promise<Job> {
  const { job } = await db.current.repos.queue.enqueue(ctx, { kind: "noop", payload: {}, createdBy: human });
  enqueued.push({ ctx, id: job.id });
  return job;
}

function input(subjectId: string, extra: { requestKey?: string; expiresAt?: Date } = {}) {
  return {
    action: "publish" as const,
    subject: { type: "job" as const, id: subjectId },
    reason: "needs review",
    requestedBy: system,
    ...extra,
  };
}

describe("openPending", () => {
  it("collapses concurrent openers into one pending request", async () => {
    const ctx = await tenant(db.current, "open-race");
    const job = await enqueueJob(ctx);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        db.current.repos.approvals.openPending(ctx, input(job.id), new Date()),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.approval.id)).size).toBe(1);
    const { items } = await db.current.repos.approvals.list(ctx, { subject: { type: "job", id: job.id } });
    expect(items).toHaveLength(1);
  });

  it("races a studio-style opener against the worker gate for the same job and action", async () => {
    const ctx = await tenant(db.current, "open-vs-worker");
    const job = await enqueueJob(ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    const claimed = (await queue.claim("w"))!;
    const outcomes = await Promise.all([
      queue.requestApproval(claimed, "w", { action: "publish", reason: "worker", ttlMs: 60_000 }),
      db.current.repos.approvals.openPending(ctx, input(job.id), new Date()),
      queue.requestApproval(claimed, "w", { action: "publish", reason: "worker", ttlMs: 60_000 }),
      db.current.repos.approvals.openPending(ctx, input(job.id), new Date()),
    ]);
    expect(outcomes).toHaveLength(4);
    const { items } = await db.current.repos.approvals.list(ctx, { subject: { type: "job", id: job.id } });
    expect(items.filter((a) => a.status === "pending")).toHaveLength(1);
  });

  it("keeps requests with different keys apart and closes a lapsed request before opening a new one", async () => {
    const ctx = await tenant(db.current, "open-keys");
    const job = await enqueueJob(ctx);
    const { approvals } = db.current.repos;
    const a = await approvals.openPending(ctx, input(job.id, { requestKey: "tool#a" }), new Date());
    const b = await approvals.openPending(ctx, input(job.id, { requestKey: "tool#b" }), new Date());
    expect([a.created, b.created]).toEqual([true, true]);
    expect(a.approval.requestKey).toBe("tool#a");

    const past = new Date(Date.now() - 1000);
    const lapsed = await approvals.openPending(
      ctx,
      input(job.id, { expiresAt: past }),
      new Date(Date.now() - 2000),
    );
    expect(lapsed.created).toBe(true);
    const next = await approvals.openPending(ctx, input(job.id), new Date());
    expect(next.created).toBe(true);
    expect(next.approval.id).not.toBe(lapsed.approval.id);
    expect(await approvals.get(ctx, lapsed.approval.id)).toMatchObject({ status: "expired" });
  });
});

describe("failExpiredApprovals", () => {
  it("fails a parked job whose approval request expired and leaves live ones alone", async () => {
    const ctx = await tenant(db.current, "expired-sweep");
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    const parked = await enqueueJob(ctx);
    const waiting = await enqueueJob(ctx);
    for (let i = 0; i < 2; i++) {
      const claimed = (await queue.claim("w"))!;
      const opened = await queue.requestApproval(claimed, "w", {
        action: "publish",
        reason: "needs review",
        ttlMs: 60_000,
      });
      expect(opened.status).toBe("created");
      expect(await queue.park(claimed, "w")).toBe(true);
    }
    expect(await queue.failExpiredApprovals()).toBe(0);

    await db.current.db
      .update(schema.approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.approvals.subjectId, parked.id));
    expect(await queue.failExpiredApprovals()).toBe(1);
    expect(await db.current.repos.jobs.get(ctx, parked.id)).toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT", retryable: false },
    });
    expect(await db.current.repos.jobs.get(ctx, waiting.id)).toMatchObject({ status: "waiting_approval" });
    expect(
      await db.current.repos.approvals.findLatest(ctx, { type: "job", id: parked.id }, "publish"),
    ).toMatchObject({ status: "expired" });
  });
});
