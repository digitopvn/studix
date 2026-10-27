import { request } from "node:http";
import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      "studix_get_job",
      "studix_get_project",
      "studix_inspect",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeLessThanOrEqual(200);
      expect(tool.outputSchema).toBeDefined();
    }
    expect(JSON.stringify(tools).length).toBeLessThan(12_000);
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
