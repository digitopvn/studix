import { request } from "node:http";
import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachMediaJobAsOperator } from "../src/operator/attach-media-job.ts";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: Record<string, unknown> | null;
  next: { tool: string }[];
  error?: { code: string; message: string };
  traceId: string;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, envelope: result.structuredContent as unknown as Envelope };
}

describe("MCP endpoint over Streamable HTTP (TS SDK client, Postgres)", () => {
  let app: TestApp;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  let keyA: string;
  let keyB: string;

  beforeAll(async () => {
    app = await startTestApp();
    tenantA = await app.provisionTenant("mcp-a");
    tenantB = await app.provisionTenant("mcp-b");
    keyA = await app.createKey(tenantA);
    keyB = await app.createKey(tenantB);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("returns 401 with a Bearer challenge and never echoes the presented key", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const missing = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(init),
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const forged = `stx_test_${"B".repeat(43)}`;
    const wrong = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${forged}`,
      },
      body: JSON.stringify(init),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(forged);

    await expect(app.connect("not-a-key")).rejects.toThrow();
  });

  it("rejects a revoked key", async () => {
    const created = await app.deps.apiKeys.create(tenantA, { name: "short-lived" });
    const client = await app.connect(created.secret);
    expect((await call(client, "studix_inspect")).envelope.status).toBe("ok");
    await app.deps.apiKeys.revoke(tenantA, created.apiKey.id);
    await expect(client.callTool({ name: "studix_inspect", arguments: {} })).rejects.toThrow();
  });

  it("lists a compact native tool set with output schemas", async () => {
    const client = await app.connect(keyA);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "studix_approve",
      "studix_cancel_job",
      "studix_create_video",
      "studix_feedback",
      "studix_get_agent_task",
      "studix_get_job",
      "studix_get_project",
      "studix_inspect",
      "studix_list_agent_tasks",
      "studix_render",
      "studix_retry_job",
      "studix_submit_agent_task",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeLessThanOrEqual(200);
      expect(tool.outputSchema).toBeDefined();
    }
    // Every tool repeats the shared envelope output schema (~1.2k chars), so the budget is ~2k per tool.
    expect(JSON.stringify(tools).length).toBeLessThan(tools.length * 2_000);
  });

  it("inspect reports the caller's workspace and the tool list", async () => {
    const client = await app.connect(keyA);
    const { envelope } = await call(client, "studix_inspect");
    expect(envelope.status).toBe("ok");
    expect(envelope.data?.workspaceId).toBe(tenantA.workspaceId);
    expect(envelope.traceId).toEqual(expect.any(String));
  });

  it("create_video returns a queued job that get_job reads back; idempotency replays the same job", async () => {
    const client = await app.connect(keyA);
    const args = { prompt: "Brand intro for Acme, 9:16, 8 seconds", idempotencyKey: "acme-intro-1" };
    const first = await call(client, "studix_create_video", args);
    expect(first.isError).toBe(false);
    expect(first.envelope.status).toBe("ok");
    const jobId = first.envelope.data?.jobId as string;
    expect(jobId).toEqual(expect.any(String));
    expect(first.envelope.data?.replayed).toBe(false);

    const job = await call(client, "studix_get_job", { jobId });
    expect(job.envelope.status).toBe("ok");
    expect(job.envelope.data).toMatchObject({ id: jobId, status: "queued" });

    const again = await call(client, "studix_create_video", args);
    expect(again.envelope.data).toMatchObject({ jobId, replayed: true });

    const project = await call(client, "studix_get_project", { projectId: first.envelope.data?.projectId });
    expect(project.envelope.status).toBe("ok");
  });

  it("blocks cross-tenant job reads and cancellation", async () => {
    const clientA = await app.connect(keyA);
    const clientB = await app.connect(keyB);
    const created = await call(clientB, "studix_create_video", { prompt: "Tenant B private video" });
    const jobId = created.envelope.data?.jobId as string;

    const read = await call(clientA, "studix_get_job", { jobId });
    expect(read.isError).toBe(true);
    expect(read.envelope).toMatchObject({ status: "error", data: null, error: { code: "NOT_FOUND" } });

    const cancel = await call(clientA, "studix_cancel_job", { jobId });
    expect(cancel.envelope.error?.code).toBe("NOT_FOUND");
    expect((await call(clientB, "studix_get_job", { jobId })).envelope.data).toMatchObject({
      status: "queued",
    });
  });

  it("retries a failed job through studix_retry_job: same job, no deadline needed, scope enforced", async () => {
    const clientA = await app.connect(keyA);
    const created = await call(clientA, "studix_create_video", { prompt: "Retry me" });
    const jobId = created.envelope.data?.jobId as string;
    // A job that never had a deadline (`deadline_at` is null) must still requeue.
    await app.db
      .client`update jobs set status = 'failed', deadline_at = null, deadline_window_ms = null, finished_at = now(),
      error = ${JSON.stringify({ code: "UNAVAILABLE", message: "bucket missing", retryable: false })}::jsonb
      where id = ${jobId}`;
    const failed = await call(clientA, "studix_get_job", { jobId });
    expect(failed.envelope.next.map((n) => n.tool)).toContain("studix_retry_job");

    // A key without job:retry is refused, even though it can read the job.
    const noRetry = await app.deps.apiKeys.create(tenantA, {
      name: "no-retry",
      scopes: ["workspace:read", "project:read", "job:cancel"],
    });
    const limited = await call(await app.connect(noRetry.secret), "studix_retry_job", { jobId });
    expect(limited.isError).toBe(true);
    expect(limited.envelope.error?.code).toBe("FORBIDDEN");
    expect((await call(clientA, "studix_get_job", { jobId })).envelope.data).toMatchObject({
      status: "failed",
    });

    // Another tenant cannot see the job, so it cannot retry it.
    const foreign = await call(await app.connect(keyB), "studix_retry_job", { jobId });
    expect(foreign.envelope.error?.code).toBe("NOT_FOUND");

    const retried = await call(clientA, "studix_retry_job", { jobId });
    expect(retried.envelope.status).toBe("ok");
    expect(retried.envelope.data).toMatchObject({ id: jobId, status: "queued" });
    expect((await app.deps.repos.jobs.get(tenantA, jobId))?.deadlineAt ?? null).toBeNull();

    // Only a failed job is retryable.
    expect((await call(clientA, "studix_retry_job", { jobId })).envelope.error?.code).toBe("CONFLICT");
  });

  it("lets only the operator attach a found Atlas prediction to a stuck submitting record", async () => {
    // Owners and admins create jobs here, but no workspace key may attach: every workspace shares the
    // platform's Atlas account, and the prediction id is trusted as given.
    const clientA = await app.connect(await app.createKey(tenantA, "owner"));
    const clientB = await app.connect(await app.createKey(tenantB, "admin"));
    const stuck = async (client: Awaited<ReturnType<typeof app.connect>>, tenant: typeof tenantA) => {
      const created = await call(client, "studix_create_video", { prompt: "Recover my upscale" });
      const jobId = created.envelope.data?.jobId as string;
      const key = `${jobId}:upscale:shot-1`;
      const intent = {
        idempotencyKey: key,
        kind: "image",
        model: "atlas/upscaler",
        attempt: 1,
        state: "submitting",
        estimatedCostCents: 4,
        submittedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      await app.db.client`update jobs set status = 'failed', finished_at = now(), attempts = 1,
        error = ${JSON.stringify({ code: "PROVIDER_ERROR", message: "may already have been charged", retryable: false })}::jsonb
        where id = ${jobId}`;
      await app.deps.repos.jobs.upsertStage(tenant, {
        jobId,
        name: "upscale",
        attempt: 1,
        status: "failed",
        mediaJobs: [intent as never],
      });
      return { jobId, stage: "upscale", idempotencyKey: key, predictionId: "pred_42" };
    };
    const args = await stuck(clientA, tenantA);
    const { jobId } = args;

    expect((await clientA.listTools()).tools.map((t) => t.name)).not.toContain("studix_attach_media_job");

    const operator = (input: typeof args, retry = false) =>
      attachMediaJobAsOperator(
        { client: app.db.client, studio: app.deps.studio },
        { ...input, operator: "ops", retry },
      );
    await expect(
      attachMediaJobAsOperator(
        { client: app.db.client, studio: app.deps.studio },
        { ...args, operator: "ops; drop table" },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(operator({ ...args, jobId: "job_missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operator({ ...args, idempotencyKey: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(operator({ ...args, predictionId: "../etc" })).rejects.toMatchObject({
      code: "VALIDATION",
    });

    const attached = await operator(args);
    expect(attached).toMatchObject({
      job: { id: jobId, status: "failed" },
      mediaJob: { state: "submitted", job: { provider: "atlas", id: "pred_42" }, attempt: 1 },
    });
    const [stage] = await app.deps.repos.jobs.listStages(tenantA, jobId);
    expect(stage?.mediaJobs).toEqual([
      expect.objectContaining({ state: "submitted", job: { provider: "atlas", id: "pred_42" } }),
    ]);
    const audit = await app.db.client`select actor_type, actor_id from audit_events
      where subject_id = ${jobId} and action = 'job.media_job_attached'`;
    expect(audit).toEqual([{ actor_type: "system", actor_id: "operator:ops" }]);

    // One upstream job is attached once, whichever workspace the job belongs to.
    const other = await stuck(clientB, tenantB);
    await expect(operator(other)).rejects.toMatchObject({ code: "CONFLICT" });

    // The record is no longer submitting; by default the operator also requeues the job.
    await expect(operator(args)).rejects.toMatchObject({ code: "CONFLICT" });
    const retried = await operator({ ...other, predictionId: "pred_43" }, true);
    expect(retried.job).toMatchObject({ id: other.jobId, status: "queued" });
  });

  it("returns validation errors as tool envelopes", async () => {
    const client = await app.connect(keyA);
    const result = await client.callTool({ name: "studix_create_video", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("rejects requests whose Host header is not allow-listed", async () => {
    // fetch() refuses to override Host, so use a raw request like a DNS-rebinding page would produce.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${app.base}/mcp`,
        { method: "POST", headers: { host: "evil.example:80" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });
});
