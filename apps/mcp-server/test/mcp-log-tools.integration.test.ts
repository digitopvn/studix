import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  // biome-ignore lint/suspicious/noExplicitAny: tool payloads are asserted field by field
  data: Record<string, any> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string };
}

/** The events array of a tool result. */
function eventsOf(res: Envelope): { message: string; eventId: string }[] {
  return (res.data?.events ?? []) as { message: string; eventId: string }[];
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

describe("studix_query_logs and studix_tail_logs over MCP (Postgres)", () => {
  let app: TestApp;
  let a: TenantContext;
  let b: TenantContext;
  let ownerKey: string;
  let adminKey: string;
  let editorKey: string;
  let jobA: string;
  let jobB: string;

  beforeAll(async () => {
    app = await startTestApp();
    a = await app.provisionTenant("logs-a");
    b = await app.provisionTenant("logs-b");
    ownerKey = await app.createKey(a, "owner");
    adminKey = await app.createKey(a, "admin");
    editorKey = await app.createKey(a, "editor");
    const { repos } = app.db;
    const enqueue = async (ctx: TenantContext) =>
      (
        await repos.queue.enqueue(ctx, {
          kind: "video.create",
          payload: {},
          createdBy: { type: "user", id: "usr_1" },
        })
      ).job.id;
    jobA = await enqueue(a);
    jobB = await enqueue(b);
    await repos.activity.append(a, {
      name: "stage.started",
      level: "info",
      message: "render started with Bearer abcdefghijklmnopqrstuvwx",
      jobId: jobA,
      attributes: {},
    });
    await repos.activity.append(a, {
      name: "stage.failed",
      level: "error",
      message: "boom",
      jobId: jobA,
      attributes: {},
    });
    await repos.activity.append(b, {
      name: "stage.started",
      level: "info",
      message: "tenant b only",
      jobId: jobB,
      attributes: {},
    });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("lets the owner read the workspace's own logs, redacted, and nothing of another workspace", async () => {
    const client = await app.connect(ownerKey);
    const res = await call(client, "studix_query_logs", { environment: "development", source: "activity" });
    expect(res.status).toBe("ok");
    const messages = eventsOf(res).map((e) => e.message);
    expect(messages).toEqual(["boom", "render started with Bearer [redacted]"]);
    expect(res.data).toMatchObject({ coverage: "complete", hasMore: false });
    expect(JSON.stringify(res.data)).not.toContain("tenant b only");

    const errors = await call(client, "studix_query_logs", {
      environment: "development",
      source: "activity",
      level: "error",
      jobId: jobA,
    });
    expect(eventsOf(errors).length).toBe(1);
  });

  it("hides another tenant's job and reports an environment it does not serve as unavailable", async () => {
    const client = await app.connect(ownerKey);
    const foreign = await call(client, "studix_query_logs", { environment: "development", jobId: jobB });
    expect(foreign.status).toBe("error");
    expect(foreign.error?.code).toBe("NOT_FOUND");
    const prod = await call(client, "studix_query_logs", { environment: "production" });
    expect(prod.data).toMatchObject({ events: [], coverage: "unavailable" });
  });

  it("denies admins, editors and keys without logs:read", async () => {
    for (const key of [adminKey, editorKey]) {
      const client = await app.connect(key);
      const res = await call(client, "studix_query_logs", { environment: "development" });
      expect(res.error?.code).toBe("FORBIDDEN");
      const tail = await call(client, "studix_tail_logs", { environment: "development", jobId: jobA });
      expect(tail.error?.code).toBe("FORBIDDEN");
    }
  });

  it("rejects out-of-window and malformed requests, and a forged cursor", async () => {
    const client = await app.connect(ownerKey);
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    const eight = await call(client, "studix_query_logs", { environment: "development", from: old });
    expect(eight.error?.code).toBe("VALIDATION");
    const forged = await call(client, "studix_query_logs", { environment: "development", cursor: "a.b" });
    expect(forged.error?.code).toBe("VALIDATION");
    await expect(
      client.callTool({ name: "studix_query_logs", arguments: { environment: "development", limit: 500 } }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("pages with a signed cursor", async () => {
    const client = await app.connect(ownerKey);
    const first = await call(client, "studix_query_logs", {
      environment: "development",
      source: "activity",
      limit: 1,
    });
    expect(first.data?.hasMore).toBe(true);
    const nextArgs = first.next[0]?.arguments as Record<string, unknown>;
    const second = await call(client, "studix_query_logs", nextArgs);
    const both = [...eventsOf(first), ...eventsOf(second)].map((e) => e.eventId);
    expect(new Set(both).size).toBe(2);
    expect(second.data?.hasMore).toBe(false);
  });

  it("tails a job: events, then done once the job has ended", async () => {
    const client = await app.connect(ownerKey);
    const first = await call(client, "studix_tail_logs", { environment: "development", jobId: jobA });
    expect(eventsOf(first).length).toBe(2);
    expect(first.data).toMatchObject({ done: false, gapDetected: false });
    await app.db.repos.jobs.update(a, jobA, { status: "succeeded" });
    const second = await call(client, "studix_tail_logs", {
      environment: "development",
      jobId: jobA,
      cursor: first.data?.nextCursor,
      waitSeconds: 2,
    });
    expect(second.data).toMatchObject({ events: [], done: true, jobStatus: "succeeded" });
    expect(second.next).toEqual([]);
  });

  it("audits successful, denied and failed reads without log text", async () => {
    const audit = await app.db.repos.audit.list(a, { subjectType: "logs", limit: 100 });
    const outcomes = new Set(audit.items.map((e) => e.data?.outcome));
    expect(outcomes).toEqual(new Set(["ok", "forbidden", "validation", "not_found"]));
    const text = JSON.stringify(audit.items);
    expect(text).not.toContain("boom");
    expect(text).not.toContain("render started");
  });

  it("refuses to put system log access on an API key", async () => {
    await expect(
      app.deps.apiKeys.create(a, { name: "sneaky", scopes: ["logs:system:read"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
