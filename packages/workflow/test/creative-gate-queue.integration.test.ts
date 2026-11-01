import { createJobBudgetPolicy, createUsageLedger } from "@studix/billing";
import { createDefaultApprovalPolicy, type TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { describe, expect, it } from "vitest";
import {
  createCreativeGateStage,
  createJobExecutor,
  createWorkerJobQueue,
  type StageDefinition,
} from "../src/index.ts";
import { silentLogger, tenant } from "./workflow-test-harness.ts";

const db = withTestDatabase();
const reviewer = { type: "user" as const, id: "usr_reviewer" };

function createWorld(options: { approvalTtlMs?: number } = {}) {
  const { repos } = db.current;
  const runs: string[] = [];
  const work = (name: string): StageDefinition => ({
    name,
    async run() {
      runs.push(name);
      return { output: { done: name } };
    },
  });
  const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
  const executor = createJobExecutor({
    queue,
    jobs: repos.jobs,
    approvals: repos.approvals,
    // A generous cost threshold: creative gates must park whatever the spend.
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1_000_000 }),
    approvalTtlMs: options.approvalTtlMs ?? 3_600_000,
    billing: createJobBudgetPolicy(),
    ledger: createUsageLedger(repos.usage),
    clock: { now: () => new Date() },
    logger: silentLogger,
    heartbeatIntervalMs: 50,
    workflows: [
      {
        kind: "test.gates",
        stages: [
          work("bible"),
          createCreativeGateStage({ gate: "G0", summary: "approve the series bible" }),
          work("design"),
          createCreativeGateStage({ gate: "G1", summary: "approve the character sheets" }),
          work("storyboard"),
        ],
        result: (o) => ({ ...o }),
      },
    ],
  });
  return {
    queue,
    runs,
    async enqueue(ctx: TenantContext) {
      const { job } = await repos.queue.enqueue(ctx, {
        kind: "test.gates",
        payload: {},
        createdBy: { type: "user", id: "usr_1" },
      });
      return job;
    },
    async runOnce(jobId: string) {
      const job = await queue.claim("w");
      expect(job?.id).toBe(jobId);
      return executor.execute(job!, "w", new AbortController().signal);
    },
  };
}

const decide = (ctx: TenantContext, id: string, status: "approved" | "rejected") =>
  db.current.repos.approvals.decide(ctx, id, { status, decidedBy: reviewer, decidedAt: new Date() });

describe("creative gates on the Postgres queue", () => {
  it("parks at G0 and G1 in turn, each with its own scoped request, and checkpoints both decisions", async () => {
    const ctx = await tenant(db.current, "creative-gates");
    const { repos } = db.current;
    const world = createWorld();
    const job = await world.enqueue(ctx);
    const subject = { type: "job" as const, id: job.id };

    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const g0 = (await repos.approvals.findLatest(ctx, subject, "creative.gate", "gate:G0"))!;
    expect(g0).toMatchObject({ status: "pending", scopeKey: "gate:G0" });
    expect(g0.reason).toMatch(/^G0: approve the series bible \(creative\.gate always requires/);
    expect(world.runs).toEqual(["bible"]);

    await decide(ctx, g0.id, "approved");
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const g1 = (await repos.approvals.findLatest(ctx, subject, "creative.gate", "gate:G1"))!;
    expect(g1).toMatchObject({ status: "pending", scopeKey: "gate:G1" });
    expect(g1.id).not.toBe(g0.id);
    // The pending G1 request is the latest of the action, so the sweeper does not resume the job early.
    expect(await world.queue.resumeDecidedApprovals()).toBe(0);
    expect(world.runs).toEqual(["bible", "design"]);

    await decide(ctx, g1.id, "approved");
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("succeeded");
    expect(world.runs).toEqual(["bible", "design", "storyboard"]);
    const done = await repos.jobs.get(ctx, job.id);
    expect(done?.result).toMatchObject({
      "gate.g0": { gate: "G0", approvalId: g0.id, decidedBy: reviewer.id },
      "gate.g1": { gate: "G1", approvalId: g1.id, decidedBy: reviewer.id },
    });
  });

  it("fails the job when a reviewer rejects a gate", async () => {
    const ctx = await tenant(db.current, "creative-gate-reject");
    const world = createWorld();
    const job = await world.enqueue(ctx);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const g0 = (await db.current.repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "creative.gate",
      "gate:G0",
    ))!;
    await decide(ctx, g0.id, "rejected");
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("failed");
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN" },
    });
    expect(world.runs).toEqual(["bible"]);
  });

  it("asks again, without redoing anything, when a gate that cannot revise gets a change request", async () => {
    const ctx = await tenant(db.current, "creative-gate-changes");
    const { repos } = db.current;
    const world = createWorld();
    const job = await world.enqueue(ctx);
    const subject = { type: "job" as const, id: job.id };
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const g0 = (await repos.approvals.findLatest(ctx, subject, "creative.gate", "gate:G0"))!;
    await repos.approvals.decide(ctx, g0.id, {
      status: "changes_requested",
      decidedBy: reviewer,
      decidedAt: new Date(),
      comment: "warmer",
      changes: { targets: ["poster"], note: "warmer", invalidated: ["asset:poster"] },
    });
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const again = (await repos.approvals.findLatest(ctx, subject, "creative.gate", "gate:G0"))!;
    expect(again.id).not.toBe(g0.id);
    expect(again).toMatchObject({ status: "pending" });
    expect(again.reason).toContain("cannot redo assets");
    expect(world.runs).toEqual(["bible"]);

    await decide(ctx, again.id, "approved");
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const done = await repos.jobs.listStages(ctx, job.id);
    expect(done.find((s) => s.name === "gate.g0")?.output).toEqual({
      gate: "G0",
      approvalId: again.id,
      decidedBy: reviewer.id,
      decidedAt: expect.any(String),
    });
  });

  it("fails the job when a gate request expires undecided", async () => {
    const ctx = await tenant(db.current, "creative-gate-expiry");
    const world = createWorld({ approvalTtlMs: 50 });
    const job = await world.enqueue(ctx);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await new Promise((r) => setTimeout(r, 80));
    expect(await world.queue.failExpiredApprovals()).toBeGreaterThanOrEqual(1);
    expect(await db.current.repos.jobs.get(ctx, job.id)).toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT", message: "creative.gate approval expired before a reviewer decided" },
    });
  });
});
