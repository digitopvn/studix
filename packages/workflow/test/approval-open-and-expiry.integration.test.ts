import { withTestDatabase } from "@studix/database/testing";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createWorkerJobQueue } from "../src/index.ts";
import { enqueueCreate, tenant } from "./workflow-test-harness.ts";

const db = withTestDatabase();
const human = { type: "user" as const, id: "usr_reviewer" };
const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 60_000);

describe("opening approvals", () => {
  it("collapses concurrent requests from every path into one pending approval", async () => {
    const ctx = await tenant(db.current, "open-race");
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const subject = { type: "job" as const, id: job.id };
    const request = (n: number) => ({
      action: "publish" as const,
      subject,
      reason: `opener ${n}`,
      requestedBy: n % 2 ? human : { type: "system" as const, id: "worker" },
      expiresAt: future(),
    });

    const opened = await Promise.all(
      Array.from({ length: 12 }, (_, n) => repos.approvals.open(ctx, request(n))),
    );
    expect(opened.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(opened.map((o) => o.approval.id)).size).toBe(1);
    const pending = await repos.approvals.list(ctx, { subject, status: "pending" });
    expect(pending.items).toHaveLength(1);

    // A different scope key is an independent request (one per connector tool + argument set).
    const other = await repos.approvals.open(ctx, { ...request(0), scopeKey: "tool#abc" });
    expect(other.created).toBe(true);
    expect(other.approval.scopeKey).toBe("tool#abc");
    expect((await repos.approvals.list(ctx, { subject, status: "pending" })).items).toHaveLength(2);
  });

  it("shares one request between the studio path and the fenced worker path", async () => {
    const ctx = await tenant(db.current, "open-vs-worker");
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    const owned = (await queue.claim("w"))!;
    const subject = { type: "job" as const, id: job.id };

    for (let round = 0; round < 5; round++) {
      const action = (["publish", "render.final", "job.start", "delete", "connector.execute"] as const)[
        round
      ]!;
      await Promise.all([
        repos.approvals.open(ctx, {
          action,
          subject,
          reason: "studio",
          requestedBy: human,
          expiresAt: future(),
        }),
        queue.requestApproval(owned, "w", { action, reason: "worker", ttlMs: 60_000 }),
        repos.approvals.open(ctx, {
          action,
          subject,
          reason: "studio 2",
          requestedBy: human,
          expiresAt: future(),
        }),
      ]);
      const pending = (await repos.approvals.list(ctx, { subject, status: "pending" })).items.filter(
        (a) => a.action === action,
      );
      expect(pending).toHaveLength(1);
    }
  });

  it("closes an expired pending request and opens a fresh one", async () => {
    const ctx = await tenant(db.current, "open-expired");
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const subject = { type: "job" as const, id: job.id };
    const stale = await repos.approvals.open(ctx, {
      action: "publish",
      subject,
      reason: "old",
      requestedBy: human,
      expiresAt: past(),
    });
    const fresh = await repos.approvals.open(ctx, {
      action: "publish",
      subject,
      reason: "new",
      requestedBy: human,
      expiresAt: future(),
    });
    expect(fresh.created).toBe(true);
    expect(fresh.approval.id).not.toBe(stale.approval.id);
    expect(await repos.approvals.get(ctx, stale.approval.id)).toMatchObject({ status: "expired" });
    const audits = (await repos.audit.list(ctx, { subjectType: "job", subjectId: job.id })).items;
    expect(audits.filter((e) => e.action === "approval.expired")).toHaveLength(1);
  });
});

describe("expired approvals on parked jobs", () => {
  async function parkedJob(slug: string, waitingOn?: { action: "publish"; scopeKey: string }) {
    const ctx = await tenant(db.current, slug);
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    // Earlier tests leave queued jobs behind; finish them until the one under test is claimed.
    let owned = (await queue.claim("w"))!;
    while (owned.id !== job.id) {
      await queue.complete(owned, "w", {});
      owned = (await queue.claim("w"))!;
    }
    const subject = { type: "job" as const, id: job.id };
    const first = await queue.requestApproval(owned, "w", { action: "publish", reason: "r", ttlMs: 60_000 });
    expect(await queue.park(owned, "w", waitingOn)).toBe(true);
    if (first.status !== "created") throw new Error("expected a created approval");
    return { ctx, repos, queue, job, subject, approval: first.approval };
  }

  it("fails the job and closes the approval once the request has expired", async () => {
    const { ctx, repos, queue, job, approval } = await parkedJob("expiry-sweep");
    // Still live: nothing happens.
    expect(await queue.failExpiredApprovals()).toBe(0);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "waiting_approval" });

    await db.current.db.execute(
      sql`update approvals set expires_at = now() - interval '1 minute' where id = ${approval.id}`,
    );
    expect(await queue.failExpiredApprovals()).toBe(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT", retryable: false, details: { reason: "approval_expired" } },
    });
    expect(await repos.approvals.get(ctx, approval.id)).toMatchObject({ status: "expired" });
    const audits = (await repos.audit.list(ctx, { subjectType: "job", subjectId: job.id })).items;
    expect(audits.filter((e) => e.action === "approval.expired")).toHaveLength(1);
    // Idempotent: a second sweep has nothing left to do.
    expect(await queue.failExpiredApprovals()).toBe(0);
  });

  it("keeps a parked job waiting while another request for it is still live", async () => {
    const { ctx, repos, queue, job, subject, approval } = await parkedJob("expiry-other-live");
    await repos.approvals.open(ctx, {
      action: "render.final",
      subject,
      reason: "other",
      requestedBy: human,
      expiresAt: future(),
    });
    await db.current.db.execute(
      sql`update approvals set expires_at = now() - interval '1 minute' where id = ${approval.id}`,
    );
    expect(await queue.failExpiredApprovals()).toBe(0);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "waiting_approval" });
    expect(await repos.approvals.get(ctx, approval.id)).toMatchObject({ status: "expired" });
  });

  it("is not held by a connector request that carries no expiry", async () => {
    const { ctx, repos, queue, job, subject, approval } = await parkedJob("expiry-connector-pending");
    await repos.approvals.open(ctx, {
      action: "connector.execute",
      subject,
      reason: "execute mutating connector tool x",
      scopeKey: "x",
      requestedBy: human,
    });
    await db.current.db.execute(
      sql`update approvals set expires_at = now() - interval '1 minute' where id = ${approval.id}`,
    );
    expect(await queue.failExpiredApprovals()).toBe(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "failed" });
  });

  it("fails a parked job whose approval was closed elsewhere, such as a reviewer answering after expiry", async () => {
    const { ctx, repos, queue, job, approval } = await parkedJob("expiry-closed-elsewhere");
    await db.current.db.execute(
      sql`update approvals set expires_at = now() - interval '1 minute' where id = ${approval.id}`,
    );
    // Same effect as decideApproval on an expired request: the row leaves `pending` without the job moving.
    await repos.approvals.decide(ctx, approval.id, { status: "expired", decidedAt: new Date() });
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "waiting_approval" });
    expect(await queue.failExpiredApprovals()).toBe(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT", details: { reason: "approval_expired" } },
    });
  });

  it("does not fail a parked job whose latest approval was decided", async () => {
    const { ctx, repos, queue, job, approval } = await parkedJob("expiry-decided");
    await repos.approvals.decide(ctx, approval.id, {
      status: "approved",
      decidedBy: human,
      decidedAt: new Date(),
    });
    expect(await queue.failExpiredApprovals()).toBe(0);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "waiting_approval" });
    expect(await queue.resumeDecidedApprovals()).toBe(1);
  });

  it("is not held by an unrelated pending request on a job the worker parked on another request", async () => {
    const { ctx, repos, queue, job, subject, approval } = await parkedJob("expiry-recorded-unrelated", {
      action: "publish",
      scopeKey: "",
    });
    await repos.approvals.open(ctx, {
      action: "render.final",
      subject,
      reason: "opened by the studio",
      requestedBy: human,
      expiresAt: future(),
    });
    await db.current.db.execute(
      sql`update approvals set expires_at = now() - interval '1 minute' where id = ${approval.id}`,
    );
    expect(await queue.failExpiredApprovals()).toBe(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { details: { reason: "approval_expired" } },
    });
  });

  it("resumes a job parked on an overrun once it is approved, whatever else is pending", async () => {
    const ctx = await tenant(db.current, "resume-recorded-unrelated");
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    let owned = (await queue.claim("w"))!;
    while (owned.id !== job.id) {
      await queue.complete(owned, "w", {});
      owned = (await queue.claim("w"))!;
    }
    const subject = { type: "job" as const, id: job.id };
    const overrun = await queue.requestApproval(owned, "w", {
      action: "agent.overrun",
      scopeKey: "agent:draft",
      reason: "overrun",
      ttlMs: 60_000,
    });
    if (overrun.status !== "created") throw new Error("expected a created approval");
    expect(await queue.park(owned, "w", { action: "agent.overrun", scopeKey: "agent:draft" })).toBe(true);
    await repos.approvals.open(ctx, {
      action: "render.final",
      subject,
      reason: "opened by the studio",
      requestedBy: human,
      expiresAt: future(),
    });
    await repos.approvals.decide(ctx, overrun.approval.id, {
      status: "approved",
      decidedBy: human,
      decidedAt: new Date(),
    });
    expect(await queue.resumeDecidedApprovals()).toBe(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "queued" });
  });

  it("keeps a job parked on its own pending request even when a different request was decided", async () => {
    const ctx = await tenant(db.current, "resume-recorded-own-pending");
    const { repos } = db.current;
    const { job } = await enqueueCreate(db.current, ctx);
    const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
    let owned = (await queue.claim("w"))!;
    while (owned.id !== job.id) {
      await queue.complete(owned, "w", {});
      owned = (await queue.claim("w"))!;
    }
    const subject = { type: "job" as const, id: job.id };
    const decided = await repos.approvals.open(ctx, {
      action: "publish",
      subject,
      reason: "decided",
      requestedBy: human,
      expiresAt: future(),
    });
    await repos.approvals.decide(ctx, decided.approval.id, {
      status: "approved",
      decidedBy: human,
      decidedAt: new Date(),
    });
    // The review gate waits on a render.final request of its own.
    await queue.requestApproval(owned, "w", { action: "render.final", reason: "review", ttlMs: 60_000 });
    expect(await queue.park(owned, "w", { action: "render.final", scopeKey: "" })).toBe(true);
    expect(await queue.resumeDecidedApprovals()).toBe(0);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "waiting_approval" });
  });
});
