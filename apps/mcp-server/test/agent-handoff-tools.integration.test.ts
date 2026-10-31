import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { BRAND_INTRO_SCRIPT_STAGE } from "@studix/skills";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: Record<string, unknown> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

const script = {
  script: {
    title: "Sương Mai Coffee",
    beats: [
      { heading: "Rang mới", voiceover: "Cà phê rang mới mỗi tuần.", durationMs: 4000 },
      { heading: "Cầu Đất", voiceover: "Hạt chọn tay từ Cầu Đất.", durationMs: 4000 },
    ],
    callToAction: "Đặt ngay hôm nay",
  },
};

describe("agent task handoff over MCP (Postgres)", () => {
  let app: TestApp;
  let tenant: TenantContext;
  let other: TenantContext;
  let key: string;
  let otherKey: string;

  beforeAll(async () => {
    app = await startTestApp();
    tenant = await app.provisionTenant("handoff-a");
    other = await app.provisionTenant("handoff-b");
    key = await app.createKey(tenant);
    otherKey = await app.createKey(other);
  });
  afterAll(async () => {
    await app?.close();
  });

  /** A job parked in waiting_host by its first attempt, with the stage's pending task. */
  async function parkedTask(expiresInMs = 60_000) {
    const { repos } = app.db;
    const { job } = await repos.queue.enqueue(tenant, {
      kind: "video.create",
      payload: { agentMode: "host" },
      createdBy: { type: "user", id: "usr_1" },
    });
    await repos.jobs.update(tenant, job.id, { status: "waiting_host" });
    const { handoff } = await repos.agentHandoffs.open(tenant, {
      jobId: job.id,
      stage: BRAND_INTRO_SCRIPT_STAGE,
      attempt: 1,
      round: 0,
      instructions: "Write the script",
      input: { brief: { brand: { name: "Sương Mai" } } },
      outputSchema: { type: "object" },
      limits: { maxTurns: 4, maxTokens: 20_000, maxCostCents: 25, timeoutMs: 120_000, tools: [] },
      expiresAt: new Date(Date.now() + expiresInMs),
    });
    return { job, handoff };
  }

  it("lists, reads and accepts a host output, requeueing the parked job", async () => {
    const { job, handoff } = await parkedTask();
    const client = await app.connect(key);

    const listed = await call(client, "studix_list_agent_tasks", { jobId: job.id });
    expect(listed.status).toBe("ok");
    expect(((listed.data?.items ?? []) as { id: string }[]).map((t) => t.id)).toEqual([handoff.id]);
    expect(listed.next[0]).toMatchObject({
      tool: "studix_get_agent_task",
      arguments: { taskId: handoff.id },
    });

    const task = await call(client, "studix_get_agent_task", { taskId: handoff.id });
    expect(task.data).toMatchObject({ attempt: 1, stage: BRAND_INTRO_SCRIPT_STAGE, limits: { maxTurns: 4 } });
    expect(task.next[0]).toMatchObject({
      tool: "studix_submit_agent_task",
      arguments: { taskId: handoff.id, attempt: 1 },
    });

    const submitted = await call(client, "studix_submit_agent_task", {
      taskId: handoff.id,
      attempt: 1,
      output: script,
      usage: { turns: 2, inputTokens: 100, outputTokens: 50 },
    });
    expect(submitted.status).toBe("ok");
    expect(submitted.data).toMatchObject({ replayed: false, task: { status: "submitted" } });
    expect(await app.db.repos.jobs.get(tenant, job.id)).toMatchObject({ status: "queued" });

    const again = await call(client, "studix_submit_agent_task", {
      taskId: handoff.id,
      attempt: 1,
      output: script,
    });
    expect(again.data).toMatchObject({ replayed: true });
    const different = await call(client, "studix_submit_agent_task", {
      taskId: handoff.id,
      attempt: 1,
      output: { script: { ...script.script, title: "Khác" } },
    });
    expect(different.error).toMatchObject({ code: "CONFLICT", details: { reason: "already_submitted" } });

    const audit = await app.db.repos.audit.list(tenant, { subjectType: "job", subjectId: job.id });
    expect(audit.items.map((e) => e.action)).toContain("agent_task.submitted");
  });

  it("rejects an output that fails the stage schema, and a stale attempt, with typed errors", async () => {
    const { job, handoff } = await parkedTask();
    const client = await app.connect(key);

    const invalid = await call(client, "studix_submit_agent_task", {
      taskId: handoff.id,
      attempt: 1,
      output: { script: { title: "x", beats: [] } },
    });
    expect(invalid.status).toBe("error");
    expect(invalid.error).toMatchObject({ code: "VALIDATION", details: { reason: "invalid_output" } });

    const stale = await call(client, "studix_submit_agent_task", {
      taskId: handoff.id,
      attempt: 2,
      output: script,
    });
    expect(stale.error).toMatchObject({ code: "CONFLICT", details: { reason: "stale_attempt" } });
    expect(await app.db.repos.jobs.get(tenant, job.id)).toMatchObject({ status: "waiting_host" });
  });

  it("refuses an expired task and a job that stopped waiting", async () => {
    const client = await app.connect(key);
    const expired = await parkedTask(-1_000);
    const late = await call(client, "studix_submit_agent_task", {
      taskId: expired.handoff.id,
      attempt: 1,
      output: script,
    });
    expect(late.error).toMatchObject({ code: "TIMEOUT", details: { reason: "expired" } });

    const moved = await parkedTask();
    await app.db.repos.jobs.update(tenant, moved.job.id, { status: "queued" });
    const notWaiting = await call(client, "studix_submit_agent_task", {
      taskId: moved.handoff.id,
      attempt: 1,
      output: script,
    });
    expect(notWaiting.error).toMatchObject({ code: "CONFLICT", details: { reason: "not_waiting" } });
  });

  it("never shows one workspace's tasks to another", async () => {
    const { handoff } = await parkedTask();
    const client = await app.connect(otherKey);
    expect((await call(client, "studix_list_agent_tasks")).data?.items).toEqual([]);
    expect((await call(client, "studix_get_agent_task", { taskId: handoff.id })).error).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      (await call(client, "studix_submit_agent_task", { taskId: handoff.id, attempt: 1, output: script }))
        .error,
    ).toMatchObject({ code: "NOT_FOUND" });
  });
});
