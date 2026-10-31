import type { TenantContext } from "@studix/core";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

const enqueueInput = (key?: string) => ({
  kind: "video.create",
  payload: { brief: "x" },
  idempotencyKey: key,
  budgetCents: 100,
  createdBy: { type: "user" as const, id: "usr_1" },
});

describe("Postgres job queue", () => {
  it("retries a failed job keeping a null deadline null and restarting a deadline window", async () => {
    const { queue, jobs } = db.current.repos;
    const ctx = await tenant("retry-deadline");
    const unbounded = (await queue.enqueue(ctx, enqueueInput("no-deadline"))).job;
    expect(unbounded.deadlineAt).toBeUndefined();
    await jobs.update(ctx, unbounded.id, { status: "failed", finishedAt: new Date() });
    const requeued = await queue.retry(ctx, unbounded.id);
    expect(requeued).toMatchObject({ status: "queued" });
    expect(requeued.deadlineAt).toBeUndefined();

    const bounded = (
      await queue.enqueue(ctx, {
        ...enqueueInput("with-deadline"),
        deadlineAt: new Date(Date.now() + 30 * 60_000),
      })
    ).job;
    await jobs.update(ctx, bounded.id, { status: "failed" });
    const window = bounded.deadlineAt!.getTime() - bounded.createdAt.getTime();
    const before = Date.now();
    const again = await queue.retry(ctx, bounded.id);
    expect(again.deadlineAt!.getTime()).toBeGreaterThanOrEqual(before + window - 1000);
  });

  it("enqueue is idempotent per workspace, including under concurrency", async () => {
    const { queue, jobs } = db.current.repos;
    const a = await tenant("idem-a");
    const b = await tenant("idem-b");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => queue.enqueue(a, enqueueInput("same-key"))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect((await jobs.list(a)).items).toHaveLength(1);

    const other = await queue.enqueue(b, enqueueInput("same-key"));
    expect(other.created).toBe(true);
    expect(other.job.id).not.toBe(results[0]!.job.id);

    const noKey1 = await queue.enqueue(a, enqueueInput());
    const noKey2 = await queue.enqueue(a, enqueueInput());
    expect(noKey1.job.id).not.toBe(noKey2.job.id);
    expect(noKey1.job).toMatchObject({
      status: "queued",
      attempts: 0,
      spentCents: 0,
      cancelRequested: false,
    });
  });

  it("cancels queued jobs immediately and flags running ones", async () => {
    const { queue, jobs } = db.current.repos;
    const ctx = await tenant("cancel");
    const queued = (await queue.enqueue(ctx, enqueueInput())).job;
    const cancelled = await queue.cancel(ctx, queued.id, "user asked");
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      error: { code: "CANCELLED" },
    });
    expect(cancelled.finishedAt).toBeInstanceOf(Date);

    const running = (await queue.enqueue(ctx, enqueueInput())).job;
    await jobs.update(ctx, running.id, {
      status: "running",
      lockedBy: "worker-1",
      leaseExpiresAt: new Date(),
    });
    const flagged = await queue.cancel(ctx, running.id);
    expect(flagged).toMatchObject({ status: "running", cancelRequested: true, lockedBy: "worker-1" });

    const finished = await queue.cancel(ctx, cancelled.id);
    expect(finished.status).toBe("cancelled");
  });

  it("starts the deadline of a job born at a gate only once it is claimed", async () => {
    const { queue } = db.current.repos;
    const ctx = await tenant("gate-deadline");
    const deadlineAt = new Date(Date.now() + 600_000);
    const { job } = await queue.enqueue(ctx, {
      ...enqueueInput(),
      deadlineAt,
      initialStatus: "waiting_approval",
    });
    expect(job.deadlineAt).toBeUndefined();
    expect(job.deadlineRemainingMs).toBeGreaterThan(590_000);
    expect(job.deadlineRemainingMs).toBeLessThanOrEqual(600_000);
  });

  it("resumes only waiting_approval jobs (compare-and-set)", async () => {
    const { queue, jobs } = db.current.repos;
    const ctx = await tenant("resume");
    const parked = (await queue.enqueue(ctx, { ...enqueueInput(), initialStatus: "waiting_approval" })).job;
    expect(parked.status).toBe("waiting_approval");
    expect((await queue.resume(ctx, parked.id)).status).toBe("queued");
    await expect(queue.resume(ctx, parked.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      jobs.update(ctx, parked.id, { progress: 0.5 }, { expectStatus: ["running"] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const updated = await jobs.update(ctx, parked.id, { status: "running", stage: "plan", lockedBy: "w" });
    const released = await jobs.update(ctx, parked.id, { status: "queued", clear: ["lockedBy", "stage"] });
    expect(updated.lockedBy).toBe("w");
    expect(released.lockedBy).toBeUndefined();
    expect(released.stage).toBeUndefined();
  });

  it("upserts stage attempts as checkpoints", async () => {
    const { queue, jobs } = db.current.repos;
    const ctx = await tenant("stages");
    const job = (await queue.enqueue(ctx, enqueueInput())).job;
    await jobs.upsertStage(ctx, {
      jobId: job.id,
      name: "plan",
      attempt: 1,
      status: "running",
      startedAt: new Date(),
    });
    await jobs.upsertStage(ctx, {
      jobId: job.id,
      name: "plan",
      attempt: 1,
      status: "succeeded",
      output: { versionId: "v1" },
    });
    await jobs.upsertStage(ctx, { jobId: job.id, name: "render", attempt: 1, status: "running" });
    const stages = await jobs.listStages(ctx, job.id);
    expect(stages.map((s) => [s.name, s.status])).toEqual([
      ["plan", "succeeded"],
      ["render", "running"],
    ]);
    expect(stages[0]?.output).toEqual({ versionId: "v1" });
  });

  it("records usage idempotently by dedupe key", async () => {
    const { usage, queue } = db.current.repos;
    const ctx = await tenant("usage");
    const job = (await queue.enqueue(ctx, enqueueInput())).job;
    const event = {
      dedupeKey: `${job.id}:render:1`,
      kind: "render",
      quantity: 15,
      unit: "second",
      costCents: 2.5,
      jobId: job.id,
    };
    const first = await usage.record(ctx, event);
    const retry = await usage.record(ctx, { ...event, costCents: 99 });
    expect(first.created).toBe(true);
    expect(retry).toEqual({ event: first.event, created: false });
    await usage.record(ctx, { ...event, dedupeKey: `${job.id}:model:1`, kind: "model", costCents: 0.1234 });
    expect(await usage.totalCostCents(ctx, { jobId: job.id })).toBeCloseTo(2.6234, 4);
  });
});
