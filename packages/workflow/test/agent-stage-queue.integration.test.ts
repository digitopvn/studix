import { createJobBudgetPolicy, createUsageLedger, splitJobUsage, USAGE_KINDS } from "@studix/billing";
import {
  type AgentRunResult,
  type AgentRuntime,
  type AgentTask,
  createDefaultApprovalPolicy,
  type TenantContext,
} from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { contentDigest } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgentStage, createJobExecutor, createWorkerJobQueue } from "../src/index.ts";
import { silentLogger, tenant } from "./workflow-test-harness.ts";

const db = withTestDatabase();
const STAGE = "test.tagline";
const Output = z.object({ tagline: z.string().min(1) });
const reviewer = { type: "user" as const, id: "usr_reviewer" };

type Step = AgentRunResult | StudixError;

/** A harness runtime that plays scripted results and records every task it was given. */
function scriptedRuntime(steps: Step[]) {
  const tasks: AgentTask[] = [];
  const runtime: AgentRuntime = {
    id: "scripted",
    async run(_ctx, task) {
      tasks.push(task);
      const step = steps.shift();
      if (!step) throw new Error("no scripted step left");
      if (step instanceof StudixError) throw step;
      return step;
    },
  };
  return { runtime, tasks };
}

const ok = (tagline: string): AgentRunResult => ({
  output: { tagline },
  turns: 1,
  costCents: 2,
  inputTokens: 100,
  outputTokens: 20,
  model: "m",
});
const turnsCap = () =>
  new StudixError("PROVIDER_ERROR", "agent used 3 turns, over the 2 limit", {
    retryable: false,
    details: { cap: "turns", spent: { costCents: 1, inputTokens: 50, outputTokens: 5, turns: 3 } },
  });

function createWorld(options: { steps?: Step[]; timeoutMs?: number; approvalTtlMs?: number } = {}) {
  const { repos } = db.current;
  const { runtime, tasks } = scriptedRuntime(options.steps ?? []);
  const queue = createWorkerJobQueue(db.current.db, { leaseMs: 30_000 });
  const stage = createAgentStage({
    name: STAGE,
    version: 1,
    inputSchema: z.object({ payload: z.object({ brand: z.string() }) }),
    outputSchema: Output,
    instructions: "Write a tagline",
    taskInput: (input) => ({ brand: input.payload.brand }),
    limits: { maxTurns: 2, maxTokens: 1_000, maxCostCents: 10, timeoutMs: options.timeoutMs ?? 60_000 },
  });
  const executor = createJobExecutor({
    queue,
    jobs: repos.jobs,
    approvals: repos.approvals,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    approvalTtlMs: options.approvalTtlMs ?? 3_600_000,
    billing: createJobBudgetPolicy(),
    ledger: createUsageLedger(repos.usage),
    agents: { handoffs: repos.agentHandoffs, runtimeFor: () => runtime },
    clock: { now: () => new Date() },
    logger: silentLogger,
    heartbeatIntervalMs: 50,
    workflows: [{ kind: "test.agent", stages: [stage], result: (o) => ({ ...o }) }],
  });
  return {
    queue,
    tasks,
    async enqueue(ctx: TenantContext, payload: Record<string, unknown> = {}) {
      const { job } = await repos.queue.enqueue(ctx, {
        kind: "test.agent",
        payload: { brand: "Sương Mai", ...payload },
        createdBy: { type: "user", id: "usr_1" },
      });
      return job;
    },
    async runOnce(jobId: string) {
      // Claims are global; only the job under test is runnable in its workspace.
      const job = await queue.claim("w");
      expect(job?.id).toBe(jobId);
      return executor.execute(job!, "w", new AbortController().signal);
    },
  };
}

const submission = (id: string, attempt: number, output: Record<string, unknown>) => ({
  id,
  attempt,
  output,
  outputDigest: contentDigest(output),
  submittedBy: reviewer,
});

describe("agent stage on the Postgres queue", () => {
  it("parks for the host, takes one fenced submission and resumes at the same attempt", async () => {
    const ctx = await tenant(db.current, "agent-host");
    const { repos } = db.current;
    const world = createWorld();
    const job = await world.enqueue(ctx, { agentMode: "host" });

    expect(await world.runOnce(job.id)).toBe("waiting_host");
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "waiting_host", attempts: 0 });
    const task = (await repos.agentHandoffs.findLatest(ctx, job.id, STAGE))!;
    expect(task).toMatchObject({ status: "pending", attempt: 1, round: 0, input: { brand: "Sương Mai" } });
    expect(task.outputSchema).toMatchObject({ type: "object", required: ["tagline"] });
    expect((await repos.agentHandoffs.listPending(ctx, { jobId: job.id })).items).toHaveLength(1);

    expect(await repos.agentHandoffs.submit(ctx, submission(task.id, 2, { tagline: "x" }))).toMatchObject({
      status: "rejected",
      reason: "stale_attempt",
    });
    // Concurrent identical submissions: one is accepted, the rest are duplicates of it.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repos.agentHandoffs.submit(ctx, submission(task.id, 1, { tagline: "Mộc" })),
      ),
    );
    expect(results.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(4);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "queued" });

    expect(await world.runOnce(job.id)).toBe("succeeded");
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({
      attempts: 1,
      result: { [STAGE]: { tagline: "Mộc" } },
    });
    const usage = await createUsageLedger(repos.usage).listForJob(ctx, job.id);
    expect(usage).toEqual([
      expect.objectContaining({
        kind: USAGE_KINDS.agentRun,
        costCents: 0,
        metadata: expect.objectContaining({ mode: "host" }),
      }),
    ]);
  });

  it("closes the task of an earlier attempt when a new attempt hands the stage off again", async () => {
    const ctx = await tenant(db.current, "agent-reopen");
    const { repos } = db.current;
    const world = createWorld();
    const job = await world.enqueue(ctx, { agentMode: "host" });
    const first = (await world.queue.claim("w"))!;
    const opened = await world.queue.openHandoff(first, "w", {
      stage: STAGE,
      round: 0,
      instructions: "i",
      input: {},
      outputSchema: {},
      limits: { maxTurns: 1, maxTokens: 1, maxCostCents: 0, timeoutMs: 60_000, tools: [] },
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(opened.status).toBe("created");
    // The worker dies before parking; the job is retried as attempt 2.
    await world.queue.retry(first, "w", { code: "INTERNAL", message: "crash", retryable: true }, new Date());
    expect(await world.runOnce(job.id)).toBe("waiting_host");

    const old = await repos.agentHandoffs.get(ctx, opened.status === "created" ? opened.handoff.id : "");
    expect(old?.status).toBe("cancelled");
    const latest = (await repos.agentHandoffs.findLatest(ctx, job.id, STAGE))!;
    expect(latest).toMatchObject({ attempt: 2, status: "pending" });
    expect((await repos.agentHandoffs.submit(ctx, submission(old!.id, 1, { tagline: "late" }))).status).toBe(
      "rejected",
    );

    // A stale worker that lost the job cannot open a task.
    expect(await world.queue.openHandoff(first, "w", { ...latest, stage: STAGE })).toEqual({
      status: "lost",
    });
  });

  it("expires an unanswered task, then asks a person for more time", async () => {
    const ctx = await tenant(db.current, "agent-expire");
    const { repos } = db.current;
    const world = createWorld({ timeoutMs: 50 });
    const job = await world.enqueue(ctx, { agentMode: "host" });
    expect(await world.runOnce(job.id)).toBe("waiting_host");
    await new Promise((r) => setTimeout(r, 80));

    expect(await world.queue.expireHostHandoffs()).toBeGreaterThanOrEqual(1);
    expect((await repos.agentHandoffs.findLatest(ctx, job.id, STAGE))?.status).toBe("expired");
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "queued" });

    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const approval = await repos.approvals.findLatest(
      ctx,
      { type: "job", id: job.id },
      "agent.overrun",
      `agent:${STAGE}`,
    );
    expect(approval).toMatchObject({ status: "pending" });
    expect(approval?.reason).toContain("time");

    await repos.approvals.decide(ctx, approval!.id, {
      status: "approved",
      decidedBy: reviewer,
      decidedAt: new Date(),
    });
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("waiting_host");
    expect(await repos.agentHandoffs.findLatest(ctx, job.id, STAGE)).toMatchObject({
      round: 1,
      status: "pending",
      limits: { timeoutMs: 100, maxTurns: 4 },
    });
  });

  it("parks the harness at a cap, reruns with doubled caps once approved, and bills both runs", async () => {
    const ctx = await tenant(db.current, "agent-overrun");
    const { repos } = db.current;
    const world = createWorld({ steps: [turnsCap(), ok("Rang mộc")] });
    const job = await world.enqueue(ctx);

    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const subject = { type: "job" as const, id: job.id };
    const approval = (await repos.approvals.findLatest(ctx, subject, "agent.overrun", `agent:${STAGE}`))!;
    expect(approval).toMatchObject({ status: "pending", scopeKey: `agent:${STAGE}` });
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "waiting_approval", spentCents: 1 });

    await repos.approvals.decide(ctx, approval.id, {
      status: "approved",
      decidedBy: reviewer,
      decidedAt: new Date(),
    });
    expect(await world.queue.resumeDecidedApprovals()).toBeGreaterThanOrEqual(1);
    expect(await world.runOnce(job.id)).toBe("succeeded");

    expect(world.tasks.map((t) => [t.maxTurns, t.maxTokens, t.maxCostCents])).toEqual([
      [2, 1_000, 10],
      [4, 2_000, 20],
    ]);
    expect((await repos.approvals.get(ctx, approval.id))?.status).toBe("consumed");
    const events = await createUsageLedger(repos.usage).listForJob(ctx, job.id);
    const split = splitJobUsage(events);
    expect(split.agent).toMatchObject({ costCents: 3, inputTokens: 150, outputTokens: 25 });
    expect(split.agent.stages).toEqual([expect.objectContaining({ stage: STAGE, attempt: 1, runs: 2 })]);
    expect(events.map((e) => e.metadata?.cap ?? null)).toEqual(["turns", null]);
  });

  it("fails the job when the overrun request expires undecided", async () => {
    const ctx = await tenant(db.current, "agent-overrun-expiry");
    const { repos } = db.current;
    const world = createWorld({ steps: [turnsCap()], approvalTtlMs: 50 });
    const job = await world.enqueue(ctx);
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await new Promise((r) => setTimeout(r, 80));
    expect(await world.queue.failExpiredApprovals()).toBeGreaterThanOrEqual(1);
    expect(await repos.jobs.get(ctx, job.id)).toMatchObject({ status: "failed" });
  });
});
