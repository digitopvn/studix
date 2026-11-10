import { request } from "node:http";
import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_ATLAS_MODEL, startTestApp, type TestApp } from "./app-test-harness.ts";

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
      "studix_attach_media_job",
      "studix_cancel_job",
      "studix_composition_attach_render",
      "studix_composition_read",
      "studix_composition_run",
      "studix_composition_write",
      "studix_create_video",
      "studix_feedback",
      "studix_get_agent_task",
      "studix_get_job",
      "studix_get_project",
      "studix_inspect",
      "studix_list_agent_runtimes",
      "studix_list_agent_tasks",
      "studix_media_exec",
      "studix_render",
      "studix_retry_job",
      "studix_review",
      "studix_skill_delete",
      "studix_skill_disable",
      "studix_skill_discover",
      "studix_skill_get",
      "studix_skill_import",
      "studix_skill_list",
      "studix_skill_update",
      "studix_skill_upload",
      "studix_submit_agent_task",
      "studix_webhook",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeLessThanOrEqual(200);
      expect(tool.outputSchema).toBeDefined();
    }
    // Every tool repeats the shared envelope output schema (~1.2k chars), so the budget is ~2.3k per tool (create_video, feedback and media_exec carry larger inputs).
    expect(JSON.stringify(tools).length).toBeLessThan(tools.length * 2_300);
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

  it("attaches a found Atlas prediction to a stuck submitting record through studix_attach_media_job", async () => {
    // Attaching needs `job:recover`, which only platform operators hold: a tenant's owner or admin does not.
    const operatorOf = (tenant: typeof tenantA) => ({
      ...tenant,
      actor: { type: "user" as const, id: tenant.actor.id, role: "operator" as const },
    });
    const clientA = await app.connect(await app.createKey(operatorOf(tenantA), "operator"));
    const stuck = async (client: Awaited<ReturnType<typeof app.connect>>, tenant: typeof tenantA) => {
      const created = await call(client, "studix_create_video", { prompt: "Recover my upscale" });
      const jobId = created.envelope.data?.jobId as string;
      const key = `${jobId}:upscale:shot-1`;
      const intent = {
        idempotencyKey: key,
        kind: "image",
        model: `atlas:${FAKE_ATLAS_MODEL}`,
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

    // Editors can retry but not attach, and neither can the workspace's owner or admin: Atlas cannot say
    // which workspace submitted a prediction, so a tenant could collect another tenant's output.
    const limited = await call(await app.connect(keyA), "studix_attach_media_job", args);
    expect(limited.envelope.error?.code).toBe("FORBIDDEN");
    for (const role of ["owner", "admin"] as const) {
      const member = await call(
        await app.connect(await app.createKey(tenantA, role)),
        "studix_attach_media_job",
        args,
      );
      expect(member.envelope.error?.code).toBe("FORBIDDEN");
    }
    await expect(app.createKey(tenantA, "operator")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const clientB = await app.connect(await app.createKey(operatorOf(tenantB), "operator"));
    const foreign = await call(clientB, "studix_attach_media_job", args);
    expect(foreign.envelope.error?.code).toBe("NOT_FOUND");
    const unknownKey = await call(clientA, "studix_attach_media_job", { ...args, idempotencyKey: "nope" });
    expect(unknownKey.envelope.error?.code).toBe("NOT_FOUND");
    const badId = await call(clientA, "studix_attach_media_job", { ...args, predictionId: "../etc" });
    expect(badId.envelope.error?.code).toBe("VALIDATION");
    // A prediction Atlas does not know is refused before anything is written.
    const unknown = await call(clientA, "studix_attach_media_job", { ...args, predictionId: "nope_42" });
    expect(unknown.envelope.error?.code).toBe("VALIDATION");

    const attached = await call(clientA, "studix_attach_media_job", args);
    expect(attached.envelope.status).toBe("ok");
    expect(attached.envelope.data).toMatchObject({
      job: { id: jobId, status: "failed" },
      mediaJob: { state: "submitted", job: { provider: "atlas", id: "pred_42" }, attempt: 1 },
    });
    expect(attached.envelope.next.map((n) => n.tool)).toContain("studix_retry_job");
    const [stage] = await app.deps.repos.jobs.listStages(tenantA, jobId);
    expect(stage?.mediaJobs).toEqual([
      expect.objectContaining({ state: "submitted", job: { provider: "atlas", id: "pred_42" } }),
    ]);
    const audit = await app.db.client`select data from audit_events
      where subject_id = ${jobId} and action = 'job.media_job_attached'`;
    expect(audit).toHaveLength(1);

    // One upstream job is attached once, whichever workspace asks.
    const other = await stuck(clientB, tenantB);
    expect((await call(clientB, "studix_attach_media_job", other)).envelope.error?.code).toBe("CONFLICT");
    const ownOther = await stuck(clientA, tenantA);
    expect((await call(clientA, "studix_attach_media_job", ownOther)).envelope.error?.code).toBe("CONFLICT");
    expect(
      (await call(clientA, "studix_attach_media_job", { ...ownOther, predictionId: "pred_43" })).envelope
        .status,
    ).toBe("ok");

    // The record is no longer submitting, and a requeued job is held by the queue, not the operator.
    expect((await call(clientA, "studix_attach_media_job", args)).envelope.error?.code).toBe("CONFLICT");
    expect((await call(clientA, "studix_retry_job", { jobId })).envelope.status).toBe("ok");
    expect((await call(clientA, "studix_attach_media_job", args)).envelope.error?.code).toBe("CONFLICT");
  });

  it("returns validation errors as tool envelopes", async () => {
    const client = await app.connect(keyA);
    const result = await client.callTool({ name: "studix_create_video", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("refuses a marketing-video brief the pack cannot script before any job is queued", async () => {
    const client = await app.connect(keyA);
    const refused = await call(client, "studix_create_video", {
      workflowTemplate: "marketing-video",
      brief: { prompt: "Quảng cáo dọc cho quán cà phê" },
    });
    expect(refused.isError).toBe(true);
    expect(refused.envelope.error?.code).toBe("VALIDATION");

    const accepted = await call(client, "studix_create_video", {
      workflowTemplate: "marketing-video",
      brief: { prompt: "Quảng cáo dọc cho quán cà phê", keyMessages: ["Cà phê rang tại chỗ"] },
    });
    expect(accepted.envelope.status).toBe("ok");
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
