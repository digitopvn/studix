import { readFileSync } from "node:fs";
import {
  type ClaudeAgentEvent,
  type ClaudeSessionRequest,
  createClaudeAgentRuntime,
  createFakeClaudeTransport,
} from "@studix/agent-runtime";
import { createJobBudgetPolicy, createUsageLedger, splitJobUsage, USAGE_KINDS } from "@studix/billing";
import {
  type AgentRuntime,
  createAgentHandoffService,
  createDefaultApprovalPolicy,
  type Job,
  type TenantContext,
} from "@studix/core";
import {
  createInMemoryAgentHandoffRepository,
  createInMemoryApprovalRepository,
  createInMemoryJobStore,
  createInMemoryUsageRepository,
  testTenant,
} from "@studix/core/testing";
import { createLogger, StudixError, systemClock } from "@studix/shared";
import { BRAND_INTRO_SCRIPT_STAGE, BrandIntroScript, brandIntroScriptStage } from "@studix/skills";
import {
  createAgentStage,
  createJobExecutor,
  type StageDefinition,
  type WorkerJobQueue,
} from "@studix/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const logger = createLogger({}, { level: "error", write: () => {} });
const brief = JSON.parse(
  readFileSync(
    new URL("../../../packages/skills/test/fixtures/brand-intro-vi-brief.json", import.meta.url),
    "utf8",
  ),
);
const SCOPE = `agent:${BRAND_INTRO_SCRIPT_STAGE}`;
const reviewer = { type: "user" as const, id: "usr_reviewer" };

const validScript = {
  script: {
    title: "Sương Mai Coffee",
    beats: [
      {
        heading: "Rang mới mỗi tuần",
        voiceover: "Cà phê rang mới mỗi tuần, thơm từ sớm mai.",
        durationMs: 4000,
      },
      { heading: "Từ nông trại", voiceover: "Hạt chọn tay từ nông trại Cầu Đất.", durationMs: 4000 },
    ],
    callToAction: "Đặt ngay hôm nay",
  },
};

const usageEvent = (u: Partial<Extract<ClaudeAgentEvent, { type: "usage" }>>): ClaudeAgentEvent => ({
  type: "usage",
  turns: 1,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.01,
  ...u,
});

/**
 * An in-memory worker world: jobs, approvals, usage and host tasks share one store, and the worker queue
 * fences every write on (status running, lockedBy, attempts) like the Postgres queue does.
 */
function createWorld(
  options: { stage?: StageDefinition; transcript?: (r: ClaudeSessionRequest) => unknown } = {},
) {
  const clock = systemClock;
  const store = createInMemoryJobStore(clock);
  const approvals = createInMemoryApprovalRepository(clock);
  const usage = createInMemoryUsageRepository(clock);
  const ledger = createUsageLedger(usage);
  const handoffs = createInMemoryAgentHandoffRepository(clock, store.jobs);
  const ctx: TenantContext = testTenant();
  const transport = createFakeClaudeTransport(
    (request) => (options.transcript?.(request) ?? []) as ClaudeAgentEvent[],
  );
  const runtime: AgentRuntime = createClaudeAgentRuntime({
    transport,
    model: "claude-test",
    killAfterMs: 20,
    closeTimeoutMs: 100,
    credentials: { resolve: async () => "sk-ant-api03-world-test-key-00000000000" },
  });

  const workerCtx = (job: Job): TenantContext => ({
    organizationId: job.organizationId,
    workspaceId: job.workspaceId,
    actor: { type: "system", id: "worker" },
  });
  const owns = async (job: Job, workerId: string) => {
    const current = await store.jobs.get(workerCtx(job), job.id);
    return (
      current?.status === "running" && current.lockedBy === workerId && current.attempts === job.attempts
    );
  };
  const fenced = async (job: Job, workerId: string, write: () => Promise<unknown>) => {
    if (!(await owns(job, workerId))) return false;
    await write();
    return true;
  };
  const finish = (job: Job, workerId: string, patch: Partial<Job>) =>
    fenced(job, workerId, () => store.jobs.update(workerCtx(job), job.id, { lockedBy: undefined, ...patch }));

  const queue: WorkerJobQueue = {
    leaseMs: 60_000,
    claim: async () => undefined,
    heartbeat: async () => ({ held: true, cancelRequested: false }),
    updateProgress: (job, w, patch) => fenced(job, w, () => store.jobs.update(workerCtx(job), job.id, patch)),
    writeStage: (job, w, stage) =>
      fenced(job, w, () =>
        store.jobs.upsertStage(workerCtx(job), { ...stage, jobId: job.id, attempt: job.attempts }),
      ),
    recordUsage: (job, w, input) =>
      fenced(job, w, () => ledger.record(workerCtx(job), { ...input, jobId: job.id })),
    async requestApproval(job, w, request) {
      if (!(await owns(job, w))) return { status: "lost" };
      const c = workerCtx(job);
      const subject = { type: "job" as const, id: job.id };
      const latest = await approvals.findLatest(c, subject, request.action, request.scopeKey ?? "");
      if (latest?.status === "pending") return { status: "existing", approval: latest };
      const opened = await approvals.open(c, {
        action: request.action,
        subject,
        ...(request.scopeKey ? { scopeKey: request.scopeKey } : {}),
        reason: request.reason,
        estimatedCostCents: request.estimatedCostCents,
        requestedBy: { type: "system", id: w },
        expiresAt: new Date(Date.now() + request.ttlMs),
      });
      return { status: "created", approval: opened.approval };
    },
    consumeApproval: (job, w, id) => fenced(job, w, () => approvals.consume(workerCtx(job), id)),
    async openHandoff(job, w, handoff) {
      if (!(await owns(job, w))) return { status: "lost" };
      const opened = await handoffs.open(workerCtx(job), {
        ...handoff,
        jobId: job.id,
        attempt: job.attempts,
      });
      return { status: opened.created ? "created" : "existing", handoff: opened.handoff };
    },
    commit: async () => ({ held: false }),
    complete: (job, w, result) => finish(job, w, { status: "succeeded", result }),
    fail: (job, w, error) => finish(job, w, { status: "failed", error }),
    cancel: (job, w, error) => finish(job, w, { status: "cancelled", error }),
    retry: (job, w, error, runAfter) => finish(job, w, { status: "queued", error, runAfter }),
    release: (job, w) => finish(job, w, { status: "queued", attempts: job.attempts - 1 }),
    park: (job, w) => finish(job, w, { status: "waiting_approval", attempts: job.attempts - 1 }),
    parkForHost: (job, w) => finish(job, w, { status: "waiting_host", attempts: job.attempts - 1 }),
    expireHostHandoffs: async () => 0,
    failExhaustedLeases: async () => 0,
    resumeDecidedApprovals: async () => 0,
    failExpiredApprovals: async () => 0,
  };

  const executor = createJobExecutor({
    queue,
    jobs: store.jobs,
    approvals,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    approvalTtlMs: 3_600_000,
    billing: createJobBudgetPolicy(),
    ledger,
    agents: { handoffs, runtimeFor: () => runtime },
    clock,
    logger,
    heartbeatIntervalMs: 10_000,
    workflows: [
      {
        kind: "test.script",
        stages: [options.stage ?? brandIntroScriptStage],
        result: (outputs) => ({ ...outputs }),
      },
    ],
  });
  const service = createAgentHandoffService({
    handoffs,
    validateOutput: (stage, output) => {
      if (stage !== (options.stage ?? brandIntroScriptStage).name)
        throw new StudixError("UNAVAILABLE", stage);
      const parsed = (options.stage ?? brandIntroScriptStage).outputSchema!.safeParse(output);
      return parsed.success
        ? { ok: true, output: parsed.data as Record<string, unknown> }
        : {
            ok: false,
            issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          };
    },
  });

  return {
    ctx,
    store,
    approvals,
    ledger,
    handoffs,
    transport,
    service,
    async enqueue(payload: Record<string, unknown> = {}) {
      const { job } = await store.queue.enqueue(ctx, {
        kind: "test.script",
        payload: { brief, ...payload },
        createdBy: { type: "user", id: "usr_1" },
      });
      return job;
    },
    /** Claim the job (attempts + 1) and run one attempt. */
    async runOnce(jobId: string) {
      const queued = await store.jobs.get(ctx, jobId);
      if (queued?.status !== "queued") throw new Error(`job is ${queued?.status}`);
      const job = await store.jobs.update(ctx, jobId, {
        status: "running",
        attempts: queued.attempts + 1,
        lockedBy: "worker",
      });
      return executor.execute(job, "worker", new AbortController().signal);
    },
    async decide(approvalId: string, status: "approved" | "rejected") {
      await approvals.decide(ctx, approvalId, { status, decidedBy: reviewer, decidedAt: new Date() });
      // What resumeDecidedApprovals does for a parked job.
      const approval = await approvals.get(ctx, approvalId);
      await store.jobs.update(
        ctx,
        approval!.subject.id,
        { status: "queued" },
        { expectStatus: ["waiting_approval"] },
      );
    },
    job: (id: string) => store.jobs.get(ctx, id),
    pendingOverrun: async (jobId: string) =>
      (await approvals.list(ctx, { subject: { type: "job", id: jobId }, status: "pending" })).items.find(
        (a) => a.action === "agent.overrun",
      ),
  };
}

describe("one agent stage, two modes", () => {
  it("produces a valid script in the harness and from the host agent, under the same output schema", async () => {
    const world = createWorld({
      transcript: () => [usageEvent({}), { type: "result", output: validScript }],
    });

    // Harness: the worker's Claude runtime (fake transport) writes the script.
    const harnessJob = await world.enqueue();
    expect(await world.runOnce(harnessJob.id)).toBe("succeeded");
    const harness = await world.job(harnessJob.id);
    expect(BrandIntroScript.safeParse(harness?.result?.[BRAND_INTRO_SCRIPT_STAGE]).success).toBe(true);
    const request = world.transport.requests[0]!;
    expect(request).toMatchObject({ maxTurns: 4, allowedTools: [] });
    expect(request.outputSchema).toMatchObject({ type: "object" });

    // Host: the job parks, the host fetches the task and submits; the worker resumes and finishes.
    const hostJob = await world.enqueue({ agentMode: "host" });
    expect(await world.runOnce(hostJob.id)).toBe("waiting_host");
    expect(await world.job(hostJob.id)).toMatchObject({ status: "waiting_host", attempts: 0 });
    const listed = await world.service.list(world.ctx, { jobId: hostJob.id });
    expect(listed.items).toHaveLength(1);
    const task = await world.service.get(world.ctx, listed.items[0]!.id);
    expect(task).toMatchObject({
      stage: BRAND_INTRO_SCRIPT_STAGE,
      attempt: 1,
      limits: { maxTurns: 4, maxTokens: 20_000, maxCostCents: 25, timeoutMs: 120_000, tools: [] },
    });
    expect(task.input).toMatchObject({ brief: { brand: { name: brief.brand.name } } });
    expect(task.outputSchema).toEqual(request.outputSchema);

    const submitted = await world.service.submit(world.ctx, {
      taskId: task.id,
      attempt: task.attempt,
      output: validScript,
      usage: { turns: 2, inputTokens: 300, outputTokens: 120, model: "host-model" },
    });
    expect(submitted.replayed).toBe(false);
    expect(await world.job(hostJob.id)).toMatchObject({ status: "queued" });
    expect(await world.runOnce(hostJob.id)).toBe("succeeded");
    const host = await world.job(hostJob.id);
    expect(BrandIntroScript.safeParse(host?.result?.[BRAND_INTRO_SCRIPT_STAGE]).success).toBe(true);
    expect(world.transport.requests).toHaveLength(1);

    // Agent spend is its own ledger kind, per stage and attempt; the host run costs Studix nothing.
    const harnessSplit = splitJobUsage(await world.ledger.listForJob(world.ctx, harnessJob.id));
    expect(harnessSplit.agent).toMatchObject({ costCents: 1, inputTokens: 100, outputTokens: 50 });
    expect(harnessSplit.agent.stages).toEqual([
      expect.objectContaining({ stage: BRAND_INTRO_SCRIPT_STAGE, attempt: 1, mode: "harness", runs: 1 }),
    ]);
    expect(harnessSplit.media.costCents).toBe(0);
    const hostSplit = splitJobUsage(await world.ledger.listForJob(world.ctx, hostJob.id));
    expect(hostSplit.agent).toMatchObject({ costCents: 0, inputTokens: 300, outputTokens: 120 });
    expect(hostSplit.agent.stages[0]).toMatchObject({ mode: "host", attempt: 1 });
  });

  it("rejects an invalid host output with a typed error and takes the same output twice as a no-op", async () => {
    const world = createWorld();
    const job = await world.enqueue({ agentMode: "host" });
    await world.runOnce(job.id);
    const [summary] = (await world.service.list(world.ctx, { jobId: job.id })).items;
    const taskId = summary!.id;

    const invalid = await world.service
      .submit(world.ctx, { taskId, attempt: 1, output: { script: { title: "x", beats: [] } } })
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(StudixError);
    expect(invalid).toMatchObject({ code: "VALIDATION", details: { reason: "invalid_output" } });
    expect(await world.job(job.id)).toMatchObject({ status: "waiting_host" });

    await expect(
      world.service.submit(world.ctx, { taskId, attempt: 2, output: validScript }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "stale_attempt" } });
    await expect(
      world.service.submit(world.ctx, { taskId, attempt: 1, output: validScript, usage: { costUsd: 1 } }),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "invalid_usage" } });

    expect(
      (await world.service.submit(world.ctx, { taskId, attempt: 1, output: validScript })).replayed,
    ).toBe(false);
    expect(
      (await world.service.submit(world.ctx, { taskId, attempt: 1, output: validScript })).replayed,
    ).toBe(true);
    const other = { script: { ...validScript.script, title: "Khác" } };
    await expect(
      world.service.submit(world.ctx, { taskId, attempt: 1, output: other }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "already_submitted" },
    });
  });

  it("redacts secrets from what the host submits", async () => {
    const world = createWorld();
    const job = await world.enqueue({ agentMode: "host" });
    await world.runOnce(job.id);
    const [summary] = (await world.service.list(world.ctx, { jobId: job.id })).items;
    const leaky = {
      script: { ...validScript.script, callToAction: "Gọi sk-ant-api03-leakedleakedleakedleaked0000 ngay" },
    };
    await world.service.submit(world.ctx, { taskId: summary!.id, attempt: 1, output: leaky });
    expect(await world.runOnce(job.id)).toBe("succeeded");
    expect(JSON.stringify((await world.job(job.id))?.result)).not.toContain("sk-ant-api03");
  });
});

describe("agent stage caps", () => {
  it.each([
    ["turns", usageEvent({ turns: 5 })],
    ["tokens", usageEvent({ inputTokens: 15_000, outputTokens: 5_001 })],
    ["cost", usageEvent({ costUsd: 0.26 })],
  ] as const)("parks for an overrun approval at the %s cap and bills what was spent", async (cap, event) => {
    let runs = 0;
    const world = createWorld({
      transcript: () => (runs++ === 0 ? [event, { type: "result", output: validScript }] : []),
    });
    const job = await world.enqueue();
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    expect(await world.job(job.id)).toMatchObject({ status: "waiting_approval", attempts: 0 });
    const approval = await world.pendingOverrun(job.id);
    expect(approval).toMatchObject({ action: "agent.overrun", scopeKey: SCOPE, status: "pending" });
    expect(approval?.reason).toContain(cap === "turns" ? "turn" : cap === "tokens" ? "token" : "cost");
    expect(world.transport.sessions[0]).toMatchObject({ closed: true });
    expect(world.transport.sessions[0]!.interrupts).toBeGreaterThan(0);

    const [line] = await world.ledger.listForJob(world.ctx, job.id);
    expect(line).toMatchObject({
      kind: USAGE_KINDS.agentRun,
      metadata: { cap, round: 0, stage: BRAND_INTRO_SCRIPT_STAGE, attempt: 1, mode: "harness" },
    });
    const stageRows = await world.store.jobs.listStages(world.ctx, job.id);
    expect(stageRows.map((s) => s.status)).toEqual(["pending"]);
  });

  it("parks at the time cap and kills the session", async () => {
    const quick = createAgentStage({
      name: "test.quick-script",
      version: 1,
      inputSchema: z.object({ payload: z.object({ brief: z.unknown() }) }),
      outputSchema: BrandIntroScript,
      instructions: "Write a script",
      taskInput: () => ({}),
      limits: { maxTurns: 4, maxTokens: 20_000, maxCostCents: 25, timeoutMs: 60 },
    });
    const world = createWorld({ stage: quick, transcript: () => new Promise(() => {}) });
    const job = await world.enqueue();
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const approval = await world.pendingOverrun(job.id);
    expect(approval).toMatchObject({ scopeKey: "agent:test.quick-script" });
    expect(approval?.reason).toContain("time");
    expect(world.transport.sessions[0]).toMatchObject({ closed: true });
  });

  it("an approved overrun runs again with every cap doubled; the ledger keeps both runs", async () => {
    let runs = 0;
    const world = createWorld({
      transcript: () =>
        runs++ === 0
          ? [usageEvent({ turns: 5 })]
          : [usageEvent({ turns: 6, costUsd: 0.02 }), { type: "result", output: validScript }],
    });
    const job = await world.enqueue();
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    const approval = (await world.pendingOverrun(job.id))!;
    await world.decide(approval.id, "approved");

    expect(await world.runOnce(job.id)).toBe("succeeded");
    expect(world.transport.requests.map((r) => r.maxTurns)).toEqual([4, 8]);
    expect(world.transport.requests[1]!.maxBudgetUsd).toBeCloseTo(0.5);
    expect((await world.approvals.get(world.ctx, approval.id))?.status).toBe("consumed");

    const events = await world.ledger.listForJob(world.ctx, job.id);
    expect(events.map((e) => e.metadata?.round)).toEqual([0, 1]);
    expect(splitJobUsage(events).agent.stages).toEqual([
      expect.objectContaining({ stage: BRAND_INTRO_SCRIPT_STAGE, attempt: 1, runs: 2, costCents: 3 }),
    ]);
  });

  it("a rejected overrun fails the stage", async () => {
    const world = createWorld({ transcript: () => [usageEvent({ turns: 5 })] });
    const job = await world.enqueue();
    expect(await world.runOnce(job.id)).toBe("waiting_approval");
    await world.decide((await world.pendingOverrun(job.id))!.id, "rejected");
    expect(await world.runOnce(job.id)).toBe("failed");
    expect(await world.job(job.id)).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
    expect(world.transport.requests).toHaveLength(1);
  });

  it("fails the stage on an unknown agent mode", async () => {
    const world = createWorld();
    const job = await world.enqueue({ agentMode: "bogus" });
    expect(await world.runOnce(job.id)).toBe("failed");
    expect(await world.job(job.id)).toMatchObject({ error: { code: "VALIDATION" } });
  });
});
