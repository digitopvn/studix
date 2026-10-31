import type { TenantContext } from "@studix/core";
import { newId, StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectorAdmin, ConnectorView } from "../src/ports.ts";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

/** Test-only connector registry; the production ConnectorAdmin comes from the gateway package. */
function inMemoryConnectors(): ConnectorAdmin {
  const rows = new Map<string, ConnectorView & { workspaceId: string }>();
  const owned = (ctx: TenantContext, id: string) => {
    const row = rows.get(id);
    if (!row || row.workspaceId !== ctx.workspaceId)
      throw new StudixError("NOT_FOUND", "connector not found");
    return row;
  };
  const view = ({ workspaceId: _ws, ...rest }: ConnectorView & { workspaceId: string }): ConnectorView =>
    rest;
  return {
    async list(ctx) {
      return [...rows.values()].filter((r) => r.workspaceId === ctx.workspaceId).map(view);
    },
    async add(ctx, input) {
      const row = { id: newId("con"), ...input, status: "active" as const, workspaceId: ctx.workspaceId };
      rows.set(row.id, row);
      return view(row);
    },
    async test(ctx, id) {
      const row = owned(ctx, id);
      return { ok: row.status === "active", toolCount: 2, tools: ["echo", "sum"] };
    },
    async disable(ctx, id) {
      const row = owned(ctx, id);
      row.status = "disabled";
      return view(row);
    },
  };
}

describe("dashboard JSON API (Better Auth session, Postgres)", () => {
  let app: TestApp;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    app = await startTestApp({ connectors: inMemoryConnectors() });
    alice = await app.signUp(`alice-${Date.now()}@example.test`);
    bob = await app.signUp(`bob-${Date.now()}@example.test`);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("serves health and readiness probes without auth", async () => {
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${app.base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true });
  });

  it("requires a session and rejects foreign origins on writes", async () => {
    const anon = await app.api("GET", "/api/me");
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    const foreign = await app.api("POST", "/api/projects", {
      cookie: alice,
      origin: "https://evil.example",
      body: { prompt: "x" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("signup provisions a personal workspace visible through /api/me", async () => {
    const res = await app.api("GET", "/api/me", { cookie: alice });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const me = await res.json();
    expect(me.role).toBe("owner");
    expect(me.workspaces).toHaveLength(1);
    expect(me.mcpUrl).toBe(`${app.base}/mcp`);
  });

  it("creates API keys shown once, lists them without secrets, and revokes them", async () => {
    const created = await app.api("POST", "/api/api-keys", { cookie: alice, body: { name: "claude-code" } });
    expect(created.status).toBe(201);
    const { apiKey, secret } = await created.json();
    expect(secret).toMatch(/^stx_test_/);

    const list = await (await app.api("GET", "/api/api-keys", { cookie: alice })).json();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(secret);

    const mcp = await app.connect(secret);
    expect((await mcp.listTools()).tools.length).toBeGreaterThan(0);

    expect((await app.api("DELETE", `/api/api-keys/${apiKey.id}`, { cookie: bob })).status).toBe(404);
    const revoked = await app.api("DELETE", `/api/api-keys/${apiKey.id}`, { cookie: alice });
    expect(await revoked.json()).toMatchObject({ status: "revoked" });
    await expect(app.deps.apiKeys.authenticate(`Bearer ${secret}`)).rejects.toThrow();
  });

  it("creates a video and exposes the project, job and activity; other tenants get 404", async () => {
    const body = { prompt: "Brand intro for Acme", aspectRatio: "9:16", idempotencyKey: "dash-1" };
    const created = await app.api("POST", "/api/projects", { cookie: alice, body });
    expect(created.status).toBe(201);
    const { project, job } = await created.json();
    expect(job.status).toBe("queued");
    expect((await app.api("POST", "/api/projects", { cookie: alice, body })).status).toBe(200);

    const projects = await (await app.api("GET", "/api/projects", { cookie: alice })).json();
    expect(projects.items.map((p: { id: string }) => p.id)).toContain(project.id);
    const jobs = await (await app.api("GET", `/api/jobs?projectId=${project.id}`, { cookie: alice })).json();
    expect(jobs.items).toHaveLength(1);

    const detail = await (await app.api("GET", `/api/jobs/${job.id}`, { cookie: alice })).json();
    expect(detail.job).toMatchObject({ id: job.id, status: "queued" });
    expect(detail.activity.map((a: { name: string }) => a.name)).toContain("dashboard.create_video");
    expect((await app.api("GET", `/api/projects/${project.id}`, { cookie: alice })).status).toBe(200);

    expect((await app.api("GET", `/api/jobs/${job.id}`, { cookie: bob })).status).toBe(404);
    expect((await app.api("GET", `/api/projects/${project.id}`, { cookie: bob })).status).toBe(404);
    expect((await app.api("POST", `/api/jobs/${job.id}/cancel`, { cookie: bob, body: {} })).status).toBe(404);
    expect((await (await app.api("GET", "/api/projects", { cookie: bob })).json()).items).toEqual([]);

    const cancelled = await app.api("POST", `/api/jobs/${job.id}/cancel`, { cookie: alice, body: {} });
    expect(cancelled.status).toBe(200);
  });

  it("retries a failed job over POST /api/jobs/:id/retry; other tenants get 404, other states 409", async () => {
    const body = { prompt: "Retry route", aspectRatio: "9:16", idempotencyKey: "dash-retry" };
    const { job } = await (await app.api("POST", "/api/projects", { cookie: alice, body })).json();
    expect((await app.api("POST", `/api/jobs/${job.id}/retry`, { cookie: alice, body: {} })).status).toBe(
      409,
    );

    await app.db.client`update jobs set status = 'failed', finished_at = now(),
      error = ${JSON.stringify({ code: "UNAVAILABLE", message: "bucket missing", retryable: false })}::jsonb
      where id = ${job.id}`;
    const failed = await (await app.api("GET", `/api/jobs/${job.id}`, { cookie: alice })).json();
    expect(failed.job).toMatchObject({ status: "failed" });

    expect((await app.api("POST", `/api/jobs/${job.id}/retry`, { cookie: bob, body: {} })).status).toBe(404);
    const retried = await app.api("POST", `/api/jobs/${job.id}/retry`, { cookie: alice, body: {} });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ id: job.id, status: "queued" });
    expect((await app.api("POST", `/api/jobs/${job.id}/retry`, { cookie: alice, body: {} })).status).toBe(
      409,
    );
  });

  it("validates input at the boundary", async () => {
    const res = await app.api("POST", "/api/projects", { cookie: alice, body: { prompt: "" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "VALIDATION" } });
    expect((await app.api("GET", "/api/nope", { cookie: alice })).status).toBe(404);
  });

  it("manages connectors per workspace through the injected admin port", async () => {
    const added = await app.api("POST", "/api/connectors", {
      cookie: alice,
      body: { name: "mock-tools", url: "http://127.0.0.1:9/mcp" },
    });
    expect(added.status).toBe(201);
    const connector = await added.json();
    const tested = await app.api("POST", `/api/connectors/${connector.id}/test`, { cookie: alice });
    expect(await tested.json()).toMatchObject({ ok: true, toolCount: 2 });
    expect((await app.api("POST", `/api/connectors/${connector.id}/disable`, { cookie: bob })).status).toBe(
      404,
    );
    const disabled = await app.api("POST", `/api/connectors/${connector.id}/disable`, { cookie: alice });
    expect(await disabled.json()).toMatchObject({ status: "disabled" });
    expect((await (await app.api("GET", "/api/connectors", { cookie: bob })).json()).items).toEqual([]);
    const bad = await app.api("POST", "/api/connectors", {
      cookie: alice,
      body: { name: "X", url: "ftp://x" },
    });
    expect(bad.status).toBe(400);
  });
  it("stores Anthropic keys without echoing them and keeps personal keys private", async () => {
    const apiKey = "sk-ant-api03-dashboardtestkeyvalue-WXYZ";
    const overview = await (await app.api("GET", "/api/providers/anthropic", { cookie: alice })).json();
    expect(overview.methods.map((m: { authMethod: string; availability: string }) => m)).toEqual([
      expect.objectContaining({ authMethod: "api_key", availability: "available" }),
      expect.objectContaining({ authMethod: "oauth_subscription", availability: "restricted" }),
    ]);

    const created = await app.api("POST", "/api/providers/anthropic/api-keys", {
      cookie: alice,
      body: { owner: "user", apiKey, label: "mine" },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const text = await created.text();
    expect(text).not.toContain(apiKey);
    const view = JSON.parse(text);
    expect(view).toMatchObject({ owner: "user", ownedByMe: true, keyHint: "sk-ant-…WXYZ" });

    const rejected = await app.api("POST", "/api/providers/anthropic/api-keys", {
      cookie: alice,
      body: { owner: "workspace", apiKey: "sk-ant-api03-rejectedrejectedrejected" },
    });
    // A refused Anthropic key is a 400, never a 401 that the dashboard could read as "signed out".
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain("rejectedrejected");

    // Bob is another tenant: neither listed nor reachable.
    const bobList = await (await app.api("GET", "/api/providers/anthropic", { cookie: bob })).json();
    expect(bobList.connections).toEqual([]);
    expect(
      (await app.api("POST", `/api/providers/anthropic/api-keys/${view.id}/test`, { cookie: bob })).status,
    ).toBe(404);

    const tested = await app.api("POST", `/api/providers/anthropic/api-keys/${view.id}/test`, {
      cookie: alice,
    });
    expect((await tested.json()).lastTest).toMatchObject({ ok: true });
    expect(
      (await app.api("DELETE", `/api/providers/anthropic/api-keys/${view.id}`, { cookie: alice })).status,
    ).toBe(200);
    const after = await (await app.api("GET", "/api/providers/anthropic", { cookie: alice })).json();
    expect(after.connections).toEqual([]);
  });

  it("accepts an opt-in Claude planner only when enabled and usable by the caller", async () => {
    const key = await app.api("POST", "/api/providers/anthropic/api-keys", {
      cookie: alice,
      body: { owner: "user", apiKey: "sk-ant-api03-plannerselectionkey-PLAN", label: "planner" },
    });
    const connection = await key.json();
    const body = {
      prompt: "Brand intro",
      planner: { runtime: "claude", providerConnectionId: connection.id },
    };
    const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

    expect(
      (await (await app.api("GET", "/api/providers/anthropic", { cookie: alice })).json()).claudePlanner,
    ).toBe(false);
    expect(await errorCode(await app.api("POST", "/api/projects", { cookie: alice, body }))).toBe(
      "UNAVAILABLE",
    );

    app.deps.claudePlanner = true;
    try {
      const created = await app.api("POST", "/api/projects", { cookie: alice, body });
      expect(created.status).toBe(201);
      const { job } = await created.json();
      const stored = await app.db.repos.jobs.get(
        { ...(await sessionTenant(app, alice)), actor: { type: "system", id: "test" } },
        job.id,
      );
      expect(stored?.payload).toMatchObject({ planner: body.planner });
      // Bob's workspace cannot select Alice's connection.
      expect(await errorCode(await app.api("POST", "/api/projects", { cookie: bob, body }))).toBe(
        "UNAVAILABLE",
      );
      const unknown = await app.api("POST", "/api/projects", {
        cookie: alice,
        body: { ...body, planner: { runtime: "other", providerConnectionId: connection.id } },
      });
      expect(unknown.status).toBe(400);
    } finally {
      app.deps.claudePlanner = false;
    }
  });
});

/** Tenant ids of the session's current workspace, via /api/me. */
async function sessionTenant(app: TestApp, cookie: string) {
  const me = await (await app.api("GET", "/api/me", { cookie })).json();
  return { organizationId: me.organization.id as string, workspaceId: me.workspace.id as string };
}
