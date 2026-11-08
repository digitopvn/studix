import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { createLogService } from "@studix/observability";
import { createLogger } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: Record<string, any> | null;
  next: { tool: string; arguments: Record<string, unknown> }[];
  error?: { code: string; message: string };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

describe("studix_query_logs and studix_tail_logs (Postgres)", () => {
  let app: TestApp;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  let ownerKey: string;
  let adminKey: string;
  let editorKey: string;
  let otherOwnerKey: string;
  let jobA: string;
  let jobB: string;

  beforeAll(async () => {
    const logger = createLogger({}, { level: "error" });
    app = await startTestApp();
    app.deps.logs = createLogService({
      activity: app.deps.repos.activity,
      audit: app.db.repos.audit,
      environment: "development",
      cursorSecret: "integration-secret",
      logger,
    });
    tenantA = await app.provisionTenant("logs-a");
    tenantB = await app.provisionTenant("logs-b");
    ownerKey = await app.createKey(tenantA, "owner");
    adminKey = await app.createKey(tenantA, "admin");
    editorKey = await app.createKey(tenantA, "editor");
    otherOwnerKey = await app.createKey(tenantB, "owner");
    const created = async (key: string, prompt: string) => {
      const client = await app.connect(key);
      const out = await client.callTool({
        name: "studix_create_video",
        arguments: { prompt, idempotencyKey: `logs-${key.slice(-8)}` },
      });
      return (out.structuredContent as unknown as Envelope).data?.jobId as string;
    };
    jobA = await created(ownerKey, "Tenant A brand intro for logs");
    jobB = await created(otherOwnerKey, "Tenant B brand intro for logs");
    await app.deps.activity?.record(tenantA, {
      name: "provider.error",
      level: "error",
      message: `upstream said ${"Bear" + "er "}${"abcdefghijkl" + "mnopqrstuv"}\nCookie: sid=zzz999`,
      scope: { jobId: jobA, stage: "render" },
    });
    await app.deps.activity?.record(tenantB, {
      name: "provider.error",
      level: "error",
      message: "tenant B only",
      scope: { jobId: jobB },
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("lets an owner read the workspace's logs, redacted, and never another tenant's", async () => {
    const client = await app.connect(ownerKey);
    const res = await call(client, "studix_query_logs", {
      environment: "development",
      source: "activity",
      level: "error",
    });
    expect(res.status).toBe("ok");
    expect(res.data?.coverage).toBe("complete");
    const text = JSON.stringify(res.data);
    expect(text).toContain("provider.error");
    expect(text).not.toContain("abcdefghijklmnopqrstuv");
    expect(text).not.toContain("zzz999");
    expect(text).not.toContain("tenant B only");
    expect(res.data?.events.every((e: { jobId?: string }) => e.jobId === jobA)).toBe(true);
  });

  it("does not leak another tenant's job: asking for it returns nothing, tailing it is NOT_FOUND", async () => {
    const client = await app.connect(ownerKey);
    const q = await call(client, "studix_query_logs", {
      environment: "development",
      source: "activity",
      jobId: jobB,
    });
    expect(q.data?.events).toEqual([]);
    const tail = await call(client, "studix_tail_logs", { environment: "development", jobId: jobB });
    expect(tail.status).toBe("error");
    expect(tail.error?.code).toBe("NOT_FOUND");
  });

  it("denies admin and editor keys by default and refuses infrastructure sources to owners", async () => {
    for (const key of [adminKey, editorKey]) {
      const client = await app.connect(key);
      const res = await call(client, "studix_query_logs", { environment: "development" });
      expect(res.error?.code).toBe("FORBIDDEN");
    }
    const owner = await app.connect(ownerKey);
    const infra = await call(owner, "studix_query_logs", {
      environment: "development",
      source: "cloudflare",
    });
    expect(infra.error?.code).toBe("FORBIDDEN");
    const services = await call(owner, "studix_query_logs", {
      environment: "development",
      services: ["infrastructure"],
    });
    expect(services.error?.code).toBe("FORBIDDEN");
  });

  it("does not let an owner mint a key with log or operator scopes it does not hold", async () => {
    await expect(
      app.deps.apiKeys.create(tenantA, { name: "escalate", scopes: ["logs:read", "logs:system:read"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Even a key an operator mints with the scope is not an operator principal.
    const operator: TenantContext = {
      ...tenantA,
      actor: { type: "user", id: tenantA.actor.id, role: "operator" },
    };
    const minted = await app.deps.apiKeys.create(operator, {
      name: "operator-minted",
      scopes: ["logs:read", "logs:system:read"],
    });
    const client = await app.connect(minted.secret);
    const res = await call(client, "studix_query_logs", { environment: "development", source: "cloudflare" });
    expect(res.error?.code).toBe("FORBIDDEN");
  });

  it("validates strictly: unknown arguments, the 7-day window and limits", async () => {
    const client = await app.connect(ownerKey);
    const bad = await client.callTool({
      name: "studix_query_logs",
      arguments: { environment: "development", url: "https://evil.test" },
    });
    expect(bad.isError).toBe(true);
    const old = await call(client, "studix_query_logs", {
      environment: "development",
      from: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
    });
    expect(old.error?.code).toBe("VALIDATION");
    const other = await call(client, "studix_query_logs", { environment: "production", source: "activity" });
    expect(other.data?.coverage).toBe("unavailable");
  });

  it("tails a job with a bounded wait and a signed cursor", async () => {
    const client = await app.connect(ownerKey);
    const first = await call(client, "studix_tail_logs", { environment: "development", jobId: jobA });
    expect(first.status).toBe("ok");
    expect(first.data?.jobDone).toBe(false);
    expect(first.data?.gapDetected).toBe(false);
    expect(first.data?.events.length).toBeGreaterThan(0);
    const started = Date.now();
    const second = await call(client, "studix_tail_logs", {
      environment: "development",
      jobId: jobA,
      cursor: first.data?.nextCursor,
      waitSeconds: 1,
    });
    expect(second.data?.events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
    const forged = await call(client, "studix_tail_logs", {
      environment: "development",
      jobId: jobA,
      cursor: `${first.data?.nextCursor}x`,
    });
    expect(forged.error?.code).toBe("VALIDATION");
  });

  it("audits successful and denied calls without log text", async () => {
    const audits = await app.db.repos.audit.list(tenantA, { subjectType: "logs", limit: 100 });
    const outcomes = audits.items.map((a) => (a.data as { outcome?: string }).outcome);
    expect(outcomes).toContain("ok");
    expect(outcomes).toContain("forbidden");
    expect(JSON.stringify(audits.items)).not.toContain("abcdefghijklmnopqrstuv");
  });

  it("offers the same log tools to WebMCP and over REST for a signed-in owner, and denies them without logs:read", async () => {
    const cookie = await app.signUp(`logs-web-${Date.now()}@example.test`);
    const listed = (await (await app.api("GET", "/api/webmcp/tools", { cookie })).json()) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain("studix_query_logs");
    expect(names).toContain("studix_tail_logs");
    const mcpTools = new Map(
      (await (await app.connect(ownerKey)).listTools()).tools.map((t) => [t.name, t.inputSchema]),
    );
    for (const t of listed.tools.filter((x) => x.name.endsWith("_logs"))) {
      expect(t.inputSchema).toEqual(mcpTools.get(t.name));
    }

    const web = (await (
      await app.api("POST", "/api/webmcp/tools/studix_query_logs", {
        cookie,
        body: { environment: "development", source: "activity" },
      })
    ).json()) as { isError?: boolean; structuredContent: Envelope };
    expect(web.isError).toBeFalsy();
    expect(web.structuredContent.data?.coverage).toBe("complete");

    const rest = await app.api("POST", "/api/logs/query", {
      cookie,
      body: { environment: "development", source: "activity" },
    });
    expect(rest.status).toBe(200);
    const body = (await rest.json()) as { coverage: string; events: unknown[] };
    expect(body.coverage).toBe("complete");
    // The new workspace holds none of tenant A's events.
    expect(JSON.stringify(body)).not.toContain("provider.error");

    const bad = await app.api("POST", "/api/logs/query", { cookie, body: { environment: "nope" } });
    expect(bad.status).toBe(400);
    const tailMissing = await app.api("POST", "/api/logs/tail", {
      cookie,
      body: { environment: "development", jobId: jobA },
    });
    expect(tailMissing.status).toBe(404);
    expect((await app.api("POST", "/api/logs/query", { body: { environment: "development" } })).status).toBe(
      401,
    );
  });
});
