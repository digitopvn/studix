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

describe("Postgres writes of agent text", () => {
  it("stores stage outputs, errors and activity events that hold NUL or half an emoji", async () => {
    const { queue, jobs, activity } = db.current.repos;
    const ctx = await tenant("agent-text");
    const { job } = await queue.enqueue(ctx, enqueueInput());
    const bad = "png\u0000\u0000 cut \uD83D";
    const stage = await jobs.upsertStage(ctx, {
      jobId: job.id,
      name: "skill-agent.run",
      attempt: 1,
      status: "failed",
      output: { [`k\u0000`]: bad },
      error: { code: "PROVIDER_ERROR", message: bad, retryable: false },
    });
    const clean = `png\uFFFD\uFFFD cut \uFFFD`;
    expect(stage.output).toEqual({ [`k\uFFFD`]: clean });
    expect(stage.error?.message).toBe(clean);
    await activity.append(ctx, {
      name: "agent.event",
      level: "info",
      jobId: job.id,
      message: bad,
      attributes: { type: "tool_end", result: bad },
    });
    const [row] = (await activity.list(ctx, { jobId: job.id })).items;
    expect(row).toMatchObject({ message: clean, attributes: { result: clean } });
  });
});

describe("Postgres job queue", () => {
  it("retry re-arms the window the caller asked for, even for a job that waited at a gate", async () => {
    const { queue, jobs } = db.current.repos;
    const ctx = await tenant("retry-window");
    const requested = 60_000;
    const { job } = await queue.enqueue(ctx, {
      ...enqueueInput(),
      initialStatus: "waiting_approval",
      deadlineAt: new Date(Date.now() + requested),
    });
    expect(job.deadlineWindowMs).toBeGreaterThan(requested - 5_000);
    expect(job.deadlineWindowMs).toBeLessThanOrEqual(requested);
    // Parked at the gate the job has no absolute deadline; the failure leaves it unarmed as well.
    await jobs.update(ctx, job.id, { status: "failed" });
    const retried = await queue.retry(ctx, job.id);
    // The window is paused until the next claim, so time queued behind other jobs never uses it up.
    expect(retried.deadlineAt).toBeUndefined();
    expect(retried.deadlineRemainingMs).toBe(job.deadlineWindowMs);
  });

  it("counts the jobs ahead of a queued job and the slots in use, across workspaces", async () => {
    const { queue, jobs } = db.current.repos;
    const a = await tenant("load-a");
    const b = await tenant("load-b");
    const holder = (await queue.enqueue(a, enqueueInput("holder"))).job;
    const mine = (await queue.enqueue(b, enqueueInput("mine"))).job;
    const later = (await queue.enqueue(a, enqueueInput("later"))).job;
    // Earlier tests in this file leave queued jobs behind, so compare against what is already there.
    const before = await jobs.queueLoad(b, mine);
    const lease = new Date(Date.now() + 60_000);
    await jobs.update(a, holder.id, { status: "running", lockedBy: "w/0", leaseExpiresAt: lease });
    const held = await jobs.queueLoad(b, mine);
    // The holder left the queue and took a slot, in a workspace other than the caller's.
    expect(held).toEqual({ ahead: before.ahead - 1, running: before.running + 1 });
    // `mine` is queued ahead of `later`, so `later` has exactly one more job in front of it.
    expect((await jobs.queueLoad(a, later)).ahead).toBe(held.ahead + 1);
    // A lease that ran out no longer holds a slot.
    await jobs.update(a, holder.id, { leaseExpiresAt: new Date(Date.now() - 1000) });
    expect((await jobs.queueLoad(b, mine)).running).toBe(before.running);
    // ... but the worker reclaims it before `mine`, so it counts as ahead again.
    expect((await jobs.queueLoad(b, mine)).ahead).toBe(before.ahead);
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
