import type { TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { describe, expect, it } from "vitest";
import {
  createTestWorker,
  enqueueCreate,
  fakePlanner,
  fakeRenderer,
  fakeStorage,
  tenant,
  waitFor,
} from "./workflow-test-harness.ts";

const db = withTestDatabase();

const usageFor = async (ctx: TenantContext, jobId: string) =>
  (await db.current.repos.usage.list(ctx, { jobId, limit: 100 })).items;

describe("video.create workflow on Postgres", () => {
  it("runs plan -> validate_ir -> render -> upload -> finalize and writes the render", async () => {
    const ctx = await tenant(db.current, "happy");
    const { project, job } = await enqueueCreate(db.current, ctx);
    const storage = fakeStorage();
    const worker = createTestWorker(db.current, "w1", {
      storage: storage.storage,
      renderCentsPerSecond: 0.2,
    });

    expect((await worker.runOnce())?.outcome).toBe("succeeded");
    const done = (await db.current.repos.jobs.get(ctx, job.id))!;
    expect(done).toMatchObject({ status: "succeeded", progress: 1, attempts: 1, spentCents: 5 });
    expect(done.lockedBy).toBeUndefined();
    const result = done.result as Record<string, string | number>;
    expect(result).toMatchObject({
      renderId: expect.stringMatching(/^rnd_/),
      projectVersionId: expect.stringMatching(/^pver_/),
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    const stages = await db.current.repos.jobs.listStages(ctx, job.id);
    expect(stages.map((s) => [s.name, s.status])).toEqual([
      ["plan", "succeeded"],
      ["validate_ir", "succeeded"],
      ["render", "succeeded"],
      ["upload", "succeeded"],
      ["finalize", "succeeded"],
    ]);
    expect(stages.every((s) => s.startedAt && s.finishedAt && s.attempt === 1)).toBe(true);

    const render = (await db.current.repos.renders.get(ctx, result.renderId as string))!;
    expect(render).toMatchObject({
      status: "succeeded",
      jobId: job.id,
      storageKey: result.storageKey,
      preset: "preview",
    });
    expect(render.probe?.bytes).toBe(result.bytes);
    expect(storage.objects.size).toBe(1);
    const updated = (await db.current.repos.projects.get(ctx, project.id))!;
    expect(updated).toMatchObject({ status: "in_review", currentVersionId: result.projectVersionId });
    expect((await usageFor(ctx, job.id)).map((u) => u.kind).sort()).toEqual([
      "provider.decision",
      "render.seconds",
      "storage.bytes",
    ]);
  });

  it("hands the job deadline to the renderer", async () => {
    const ctx = await tenant(db.current, "render-deadline");
    const deadlineAt = new Date(Date.now() + 10 * 60_000);
    await enqueueCreate(db.current, ctx, { deadlineAt });
    const fake = fakeRenderer();
    const worker = createTestWorker(db.current, "w-deadline", { renderer: fake.renderer });
    expect((await worker.runOnce())?.outcome).toBe("succeeded");
    expect(fake.state.deadlineAt?.getTime()).toBe(deadlineAt.getTime());
  });

  it("does not move the project pointer back when a feedback job runs after a newer patch", async () => {
    const ctx = await tenant(db.current, "stale-pointer");
    const first = await enqueueCreate(db.current, ctx);
    const worker = createTestWorker(db.current, "w1");
    expect((await worker.runOnce())?.outcome).toBe("succeeded");
    const v1 = (await db.current.repos.projects.get(ctx, first.project.id))!.currentVersionId!;
    const base = (await db.current.repos.projects.getVersion(ctx, v1))!;
    const author = { type: "user" as const, id: "usr_1" };
    const v2 = await db.current.repos.projects.createVersion(ctx, {
      projectId: first.project.id,
      ir: base.ir,
      source: "patch",
      parentVersionId: v1,
      createdBy: author,
    });
    const v3 = await db.current.repos.projects.createVersion(ctx, {
      projectId: first.project.id,
      ir: base.ir,
      source: "patch",
      parentVersionId: v2.id,
      createdBy: author,
    });
    // Patch B already moved the head to v3; the job queued by patch A (v2) is still waiting.
    await db.current.repos.projects.update(ctx, first.project.id, { currentVersionId: v3.id });
    await db.current.repos.queue.enqueue(ctx, {
      kind: "video.create",
      projectId: first.project.id,
      payload: {
        projectId: first.project.id,
        versionId: v2.id,
        makeCurrent: false,
        renderPreset: "preview",
      },
      createdBy: author,
      budgetCents: 500,
      maxAttempts: 3,
    });
    expect((await worker.runOnce())?.outcome).toBe("succeeded");
    expect((await db.current.repos.projects.get(ctx, first.project.id))!.currentVersionId).toBe(v3.id);
  });

  it("returns the same job for a repeated idempotency key", async () => {
    const ctx = await tenant(db.current, "idem");
    const first = await enqueueCreate(db.current, ctx, { idempotencyKey: "brief-1" });
    const again = await db.current.repos.queue.enqueue(ctx, {
      kind: "video.create",
      payload: {},
      idempotencyKey: "brief-1",
      createdBy: { type: "user", id: "usr_1" },
    });
    expect(again).toMatchObject({ created: false, job: { id: first.job.id } });
    await db.current.repos.queue.cancel(ctx, first.job.id); // keep the shared queue empty for later tests
  });

  it("resumes from the last checkpoint after a worker dies mid-render", async () => {
    const ctx = await tenant(db.current, "crash");
    const { job } = await enqueueCreate(db.current, ctx);
    const plan = fakePlanner();
    // Worker A's heartbeats hang and its renderer hangs: it behaves like a process that died mid-render.
    const a = createTestWorker(db.current, "worker-a", {
      planner: plan.planner,
      renderer: fakeRenderer({ hold: "forever" }).renderer,
      leaseMs: 3000,
      heartbeatIntervalMs: 1000,
      heartbeat: "hang",
    });
    const claimed = (await a.queue.claim("worker-a"))!;
    const aOutcome = a.executor.execute(claimed, "worker-a", a.shutdown.signal);
    await waitFor(async () => (await db.current.repos.jobs.get(ctx, job.id))?.stage === "render");
    expect(plan.state.calls).toBe(1);

    const b = createTestWorker(db.current, "worker-b", { planner: plan.planner });
    expect(await b.queue.claim("worker-b")).toBeUndefined(); // lease still valid
    const reclaimed = await waitFor(() => b.queue.claim("worker-b"));
    expect(reclaimed).toMatchObject({ id: job.id, attempts: 2, lockedBy: "worker-b" });
    expect(await b.executor.execute(reclaimed, "worker-b", b.shutdown.signal)).toBe("succeeded");
    expect(plan.state.calls).toBe(1); // plan checkpoint reused, not re-planned

    a.shutdown.abort(); // the stale worker wakes up: it must not overwrite the new owner's result
    expect(await aOutcome).toBe("lease_lost");
    const done = (await db.current.repos.jobs.get(ctx, job.id))!;
    expect(done).toMatchObject({ status: "succeeded", attempts: 2 });
    const stages = await db.current.repos.jobs.listStages(ctx, job.id);
    expect(stages.filter((s) => s.name === "plan")).toHaveLength(1);
    // The stale attempt's row is closed when the job is reclaimed; its late writes are fenced out.
    expect(stages.filter((s) => s.name === "render").map((s) => [s.attempt, s.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    expect((await db.current.repos.renders.listByProject(ctx, done.projectId!)).items).toHaveLength(1);
  });

  it("rides out a single failed heartbeat without losing the attempt", async () => {
    const ctx = await tenant(db.current, "hb-blip");
    const { job } = await enqueueCreate(db.current, ctx);
    const base = fakeRenderer().renderer;
    const a = createTestWorker(db.current, "worker-blip", {
      // The render outlives several lease periods, so the lease must keep being renewed.
      renderer: {
        ...base,
        render: async (ir, opts) => {
          await new Promise((r) => setTimeout(r, 3500));
          return base.render(ir, opts);
        },
      },
      leaseMs: 1500,
      heartbeatIntervalMs: 500,
    });
    const realHeartbeat = a.queue.heartbeat;
    let beats = 0;
    a.queue.heartbeat = async (...args) => {
      if (++beats === 1) throw new Error("database blip");
      return realHeartbeat(...args);
    };
    const claimed = (await a.queue.claim("worker-blip"))!;
    expect(await a.executor.execute(claimed, "worker-blip", a.shutdown.signal)).toBe("succeeded");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("schedules no heartbeat after the attempt settles", async () => {
    const ctx = await tenant(db.current, "hb-settle");
    await enqueueCreate(db.current, ctx);
    const base = fakeRenderer().renderer;
    const a = createTestWorker(db.current, "worker-settle", {
      renderer: {
        ...base,
        render: async (ir, opts) => {
          await new Promise((r) => setTimeout(r, 150));
          return base.render(ir, opts);
        },
      },
      heartbeatIntervalMs: 100,
    });
    let beats = 0;
    // The first beat is still in flight when the job completes, then fails (database down): it must
    // not start a retry loop for a finished job.
    a.queue.heartbeat = async () => {
      beats++;
      await new Promise((r) => setTimeout(r, 400));
      throw new Error("database unreachable");
    };
    const claimed = (await a.queue.claim("worker-settle"))!;
    expect(await a.executor.execute(claimed, "worker-settle", a.shutdown.signal)).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 800));
    expect(beats).toBe(1);
  });

  it("does not apply a stalled worker's project writes after another worker finished the job", async () => {
    const ctx = await tenant(db.current, "stall-write");
    const { project, job } = await enqueueCreate(db.current, ctx);
    const { repos } = db.current;
    // Worker A reads the project in validate_ir and then freezes (GC pause, frozen pod) before writing.
    let wake!: () => void;
    const frozen = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const a = createTestWorker(db.current, "worker-a", {
      projects: {
        ...repos.projects,
        getVersion: async (c, id) => {
          await frozen;
          return repos.projects.getVersion(c, id);
        },
      },
      // Its heartbeats hang too, so nothing on its side notices the lease running out.
      heartbeat: "hang",
    });
    const claimed = (await a.queue.claim("worker-a"))!;
    const aOutcome = a.executor.execute(claimed, "worker-a", a.shutdown.signal);
    await waitFor(async () => (await repos.jobs.get(ctx, job.id))?.stage === "validate_ir");
    // A's lease lapses while it is frozen, and B reclaims the job.
    await repos.jobs.update(ctx, job.id, { leaseExpiresAt: new Date(Date.now() - 1000) });

    const b = createTestWorker(db.current, "worker-b");
    const reclaimed = await waitFor(() => b.queue.claim("worker-b"));
    expect(await b.executor.execute(reclaimed, "worker-b", b.shutdown.signal)).toBe("succeeded");
    const finished = (await repos.projects.get(ctx, project.id))!;
    expect(finished.status).toBe("in_review");
    const versions = await repos.projects.listVersions(ctx, project.id);
    expect(versions.items).toHaveLength(1);

    wake();
    expect(await aOutcome).toBe("lease_lost");
    // Without the fence A would set status back to "rendering" and leave the project stuck there.
    expect(await repos.projects.get(ctx, project.id)).toMatchObject({
      status: "in_review",
      currentVersionId: finished.currentVersionId,
    });
    expect((await repos.projects.listVersions(ctx, project.id)).items).toHaveLength(1);
    expect((await repos.jobs.get(ctx, job.id))?.status).toBe("succeeded");
  });

  it("does not create a render from a stalled worker after another worker finalized the job", async () => {
    const ctx = await tenant(db.current, "stall-render");
    const { project, job } = await enqueueCreate(db.current, ctx);
    const { repos } = db.current;
    let wake!: () => void;
    const frozen = new Promise<void>((resolve) => {
      wake = resolve;
    });
    // Worker A freezes in finalize after reading "no render yet".
    const a = createTestWorker(db.current, "worker-a", {
      renders: {
        get: async () => {
          await frozen;
          return undefined;
        },
      },
      // Its heartbeats hang too, so nothing on its side notices the lease running out.
      heartbeat: "hang",
    });
    const claimed = (await a.queue.claim("worker-a"))!;
    const aOutcome = a.executor.execute(claimed, "worker-a", a.shutdown.signal);
    await waitFor(async () => (await repos.jobs.get(ctx, job.id))?.stage === "finalize");
    // A's lease lapses while it is frozen, and B reclaims the job.
    await repos.jobs.update(ctx, job.id, { leaseExpiresAt: new Date(Date.now() - 1000) });

    const b = createTestWorker(db.current, "worker-b");
    const reclaimed = await waitFor(() => b.queue.claim("worker-b"));
    expect(await b.executor.execute(reclaimed, "worker-b", b.shutdown.signal)).toBe("succeeded");

    wake();
    // A's create is refused by the fence (a CONFLICT on the render id would mean it reached the table).
    expect(await aOutcome).toBe("lease_lost");
    expect((await repos.renders.listByProject(ctx, project.id)).items).toHaveLength(1);
    expect((await repos.projects.get(ctx, project.id))?.status).toBe("in_review");
  });

  it("abandons an attempt before its lease lapses when heartbeats keep failing", async () => {
    const ctx = await tenant(db.current, "hb-fail");
    const { job } = await enqueueCreate(db.current, ctx);
    const a = createTestWorker(db.current, "worker-hb", {
      renderer: fakeRenderer({ hold: "forever" }).renderer,
      // Production ratio: the worker beats every lease/3.
      leaseMs: 1500,
      heartbeatIntervalMs: 500,
    });
    a.queue.heartbeat = async () => {
      throw new Error("database unreachable");
    };
    const claimed = (await a.queue.claim("worker-hb"))!;
    const outcome = await a.executor.execute(claimed, "worker-hb", a.shutdown.signal);
    expect(outcome).toBe("lease_lost");
    // It stopped while it still owned the job, so no second worker could have been running it.
    const current = (await db.current.repos.jobs.get(ctx, job.id))!;
    expect(current.lockedBy).toBe("worker-hb");
    expect(current.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await a.queue.cancel(claimed, "worker-hb", {
      code: "CANCELLED",
      message: "test cleanup",
      retryable: false,
    });
  });

  it("fails a job whose lease expired on its last attempt", async () => {
    const ctx = await tenant(db.current, "exhausted");
    const { job } = await enqueueCreate(db.current, ctx, { maxAttempts: 1 });
    const a = createTestWorker(db.current, "a", { leaseMs: 200 });
    await a.queue.claim("a");
    await new Promise((r) => setTimeout(r, 250));
    expect(await a.queue.claim("b")).toBeUndefined();
    expect(await a.queue.failExhaustedLeases()).toBeGreaterThanOrEqual(1);
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "INTERNAL", retryable: false, details: { reason: "lease_expired", lockedBy: "a" } },
    });
  });

  it("observes cancellation of a running job", async () => {
    const ctx = await tenant(db.current, "cancel");
    const { job } = await enqueueCreate(db.current, ctx);
    const worker = createTestWorker(db.current, "w", {
      renderer: fakeRenderer({ hold: "until-abort" }).renderer,
    });
    const running = worker.runOnce();
    await waitFor(async () => (await db.current.repos.jobs.get(ctx, job.id))?.stage === "render");
    await db.current.repos.queue.cancel(ctx, job.id, "user changed their mind");
    expect((await running)?.outcome).toBe("cancelled");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "cancelled",
      error: { code: "CANCELLED" },
    });
    const render = (await db.current.repos.jobs.listStages(ctx, job.id)).find((s) => s.name === "render");
    expect(render?.status).toBe("cancelled");
  });

  it("fails with TIMEOUT when the deadline passes mid-stage", async () => {
    const ctx = await tenant(db.current, "timeout");
    const { job } = await enqueueCreate(db.current, ctx, { deadlineAt: new Date(Date.now() + 1500) });
    const worker = createTestWorker(db.current, "w", {
      renderer: fakeRenderer({ hold: "forever" }).renderer,
    });
    expect((await worker.runOnce())?.outcome).toBe("failed");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT", retryable: false },
    });
  });

  it("stops with BUDGET_EXCEEDED before running further paid stages", async () => {
    const ctx = await tenant(db.current, "budget");
    const overspend = await enqueueCreate(db.current, ctx, { budgetCents: 50 });
    const render = fakeRenderer();
    const worker = createTestWorker(db.current, "w", {
      planner: fakePlanner({ costCents: 80 }).planner,
      renderer: render.renderer,
    });
    expect((await worker.runOnce())?.outcome).toBe("failed");
    expect(await db.current.repos.jobs.get(ctx, overspend.job.id)).toMatchObject({
      status: "failed",
      spentCents: 80,
      error: { code: "BUDGET_EXCEEDED", retryable: false },
    });

    // The render estimate (15s * 10¢) is refused up front.
    const pricey = await enqueueCreate(db.current, ctx, { budgetCents: 100 });
    const worker2 = createTestWorker(db.current, "w2", {
      renderer: render.renderer,
      renderCentsPerSecond: 10,
    });
    expect((await worker2.runOnce())?.outcome).toBe("failed");
    expect((await db.current.repos.jobs.get(ctx, pricey.job.id))?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(render.state.calls).toBe(0);
  });

  it("retries retryable failures with backoff without duplicating usage or work", async () => {
    const ctx = await tenant(db.current, "retry");
    const { job } = await enqueueCreate(db.current, ctx);
    const plan = fakePlanner();
    const render = fakeRenderer();
    const worker = createTestWorker(db.current, "w", {
      planner: plan.planner,
      renderer: render.renderer,
      storage: fakeStorage({ failPuts: 1 }).storage,
    });
    expect((await worker.runOnce())?.outcome).toBe("retrying");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "queued",
      error: { code: "UNAVAILABLE" },
    });
    const second = await waitFor(() => worker.runOnce());
    expect(second.outcome).toBe("succeeded");
    expect(second.job.attempts).toBe(2);
    expect([plan.state.calls, render.state.calls]).toEqual([1, 1]);
    const usage = await usageFor(ctx, job.id);
    expect(usage.map((u) => u.kind).sort()).toEqual(["provider.decision", "render.seconds", "storage.bytes"]);
  });

  it("fails immediately on non-retryable errors", async () => {
    const ctx = await tenant(db.current, "fatal");
    const { job } = await enqueueCreate(db.current, ctx);
    const worker = createTestWorker(db.current, "w", {
      renderer: fakeRenderer({ supported: false }).renderer,
    });
    expect((await worker.runOnce())?.outcome).toBe("failed");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: { code: "VALIDATION" },
    });
  });
});
