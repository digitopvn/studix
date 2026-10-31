import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: Record<string, unknown> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string };
}

interface Me {
  user: { id: string };
  role: string;
  organization: { id: string };
  workspace: { id: string };
}
interface Created {
  job: { id: string };
}
interface JobBody {
  id: string;
  status: string;
  attempts?: number;
  maxAttempts?: number;
  error?: unknown;
}
interface ApiError {
  error: { code: string; message: string };
}

const FAILED = {
  status: "failed" as const,
  attempts: 3,
  error: { code: "UNAVAILABLE" as const, message: "bucket missing", retryable: false },
  finishedAt: new Date(),
};

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, envelope: result.structuredContent as unknown as Envelope };
}

describe("retrying a failed job over the HTTP dashboard API and the MCP surface", () => {
  let app: TestApp;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  let keyEditor: string;
  let keyB: string;
  let aliceCookie: string;
  let aliceCtx: TenantContext;
  let viewerCookie: string;

  /** A dashboard request as the signed-in session; `workspaceId` selects a membership like the dashboard does. */
  async function dashboard<T = unknown>(
    method: string,
    path: string,
    cookie: string,
    options: { body?: unknown; workspaceId?: string } = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { origin: app.base, cookie };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.workspaceId) headers["x-studix-workspace"] = options.workspaceId;
    const res = await fetch(`${app.base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** A video job in the workspace, then marked failed the way a worker leaves it after a non-retryable error. */
  async function failedJobIn(ctx: TenantContext, kind = "video.create"): Promise<string> {
    const { repos } = app.db;
    const { job } = await repos.queue.enqueue(ctx, { kind, payload: {}, createdBy: ctx.actor });
    await repos.jobs.update(ctx, job.id, FAILED);
    return job.id;
  }

  beforeAll(async () => {
    app = await startTestApp();
    tenantA = await app.provisionTenant("retry-a");
    tenantB = await app.provisionTenant("retry-b");
    keyEditor = await app.createKey(tenantA);
    keyB = await app.createKey(tenantB);

    aliceCookie = await app.signUp(`retry-alice-${Date.now()}@example.test`);
    const me = await dashboard<Me>("GET", "/api/me", aliceCookie);
    aliceCtx = {
      organizationId: me.body.organization.id,
      workspaceId: me.body.workspace.id,
      actor: { type: "user", id: me.body.user.id, role: "owner" },
    };

    // A second person joins Alice's workspace as a viewer; their own personal workspace stays the default.
    viewerCookie = await app.signUp(`retry-viewer-${Date.now()}@example.test`);
    const viewer = await dashboard<Me>("GET", "/api/me", viewerCookie);
    await app.deps.repos.workspaces.upsertMember(aliceCtx, { userId: viewer.body.user.id, role: "viewer" });
  });
  afterAll(async () => {
    await app?.close();
  });

  describe("POST /api/jobs/:jobId/retry", () => {
    it("requeues a failed job as the same job and clears its failure", async () => {
      const created = await dashboard<Created>("POST", "/api/projects", aliceCookie, {
        body: { prompt: "Brand intro for Acme" },
      });
      expect(created.status).toBe(201);
      const jobId = created.body.job.id as string;
      await app.deps.repos.jobs.update(aliceCtx, jobId, FAILED);

      const retried = await dashboard<JobBody>("POST", `/api/jobs/${jobId}/retry`, aliceCookie);
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ id: jobId, status: "queued", attempts: 3 });
      expect(retried.body.error).toBeUndefined();
      expect(retried.body.maxAttempts).toBeGreaterThan(3);

      const detail = await dashboard<{ job: JobBody }>("GET", `/api/jobs/${jobId}`, aliceCookie);
      expect(detail.body.job).toMatchObject({ id: jobId, status: "queued" });
      const audit = await app.db.repos.audit.list(aliceCtx, { subjectType: "job", subjectId: jobId });
      expect(audit.items.map((e) => e.action)).toContain("job.retried");
    });

    it("refuses a job that is not failed with CONFLICT and leaves it untouched", async () => {
      const created = await dashboard<Created>("POST", "/api/projects", aliceCookie, {
        body: { prompt: "Still queued" },
      });
      const jobId = created.body.job.id as string;
      const res = await dashboard<ApiError>("POST", `/api/jobs/${jobId}/retry`, aliceCookie);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CONFLICT");
      expect(await app.deps.repos.jobs.get(aliceCtx, jobId)).toMatchObject({ status: "queued" });
    });

    it("refuses a failed publish job with VALIDATION and never requeues it", async () => {
      const jobId = await failedJobIn(aliceCtx, "video.publish");
      const res = await dashboard<ApiError>("POST", `/api/jobs/${jobId}/retry`, aliceCookie);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      expect(await app.deps.repos.jobs.get(aliceCtx, jobId)).toMatchObject({ status: "failed" });
    });

    it("answers NOT_FOUND for an unknown job and for another tenant's failed job", async () => {
      const unknown = await dashboard<ApiError>("POST", "/api/jobs/job_does_not_exist/retry", aliceCookie);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe("NOT_FOUND");

      const bobCookie = await app.signUp(`retry-bob-${Date.now()}@example.test`);
      const foreign = await failedJobIn(aliceCtx);
      const res = await dashboard<ApiError>("POST", `/api/jobs/${foreign}/retry`, bobCookie);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(await app.deps.repos.jobs.get(aliceCtx, foreign)).toMatchObject({ status: "failed" });
    });

    it("refuses a viewer of the workspace with FORBIDDEN", async () => {
      const jobId = await failedJobIn(aliceCtx);
      const asViewer = { workspaceId: aliceCtx.workspaceId };
      expect((await dashboard<Me>("GET", "/api/me", viewerCookie, asViewer)).body.role).toBe("viewer");
      const res = await dashboard<ApiError>("POST", `/api/jobs/${jobId}/retry`, viewerCookie, asViewer);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "FORBIDDEN", message: "Missing permission job:retry" });
      expect(await app.deps.repos.jobs.get(aliceCtx, jobId)).toMatchObject({ status: "failed" });
    });

    it("is not reachable with an API key: the dashboard API is session-only", async () => {
      const jobId = await failedJobIn(tenantA);
      const res = await fetch(`${app.base}/api/jobs/${jobId}/retry`, {
        method: "POST",
        headers: { origin: app.base, authorization: `Bearer ${keyEditor}` },
      });
      expect(res.status).toBe(401);
      expect(await app.deps.repos.jobs.get(tenantA, jobId)).toMatchObject({ status: "failed" });
    });
  });

  describe("studix_retry_job over MCP", () => {
    it("requeues a failed job as the same job and points get_job's next actions at it", async () => {
      const client = await app.connect(keyEditor);
      const created = await call(client, "studix_create_video", { prompt: "MCP retry target" });
      const jobId = created.envelope.data?.jobId as string;
      await app.deps.repos.jobs.update(tenantA, jobId, FAILED);

      const failed = await call(client, "studix_get_job", { jobId });
      expect(failed.envelope.next).toContainEqual(
        expect.objectContaining({ tool: "studix_retry_job", arguments: { jobId } }),
      );

      const retried = await call(client, "studix_retry_job", { jobId });
      expect(retried.isError).toBe(false);
      expect(retried.envelope).toMatchObject({ status: "ok", data: { id: jobId, status: "queued" } });
      expect(await app.deps.repos.jobs.get(tenantA, jobId)).toMatchObject({ id: jobId, status: "queued" });
    });

    it("returns CONFLICT for a job that is not failed", async () => {
      const client = await app.connect(keyEditor);
      const created = await call(client, "studix_create_video", { prompt: "MCP not failed" });
      const jobId = created.envelope.data?.jobId as string;
      const res = await call(client, "studix_retry_job", { jobId });
      expect(res.isError).toBe(true);
      expect(res.envelope).toMatchObject({ status: "error", data: null, error: { code: "CONFLICT" } });
    });

    it("returns VALIDATION for a failed publish job", async () => {
      const jobId = await failedJobIn(tenantA, "video.publish");
      const client = await app.connect(keyEditor);
      const res = await call(client, "studix_retry_job", { jobId });
      expect(res.envelope.error?.code).toBe("VALIDATION");
    });

    it("returns NOT_FOUND across tenants", async () => {
      const jobId = await failedJobIn(tenantA);
      const clientB = await app.connect(keyB);
      const res = await call(clientB, "studix_retry_job", { jobId });
      expect(res.isError).toBe(true);
      expect(res.envelope.error?.code).toBe("NOT_FOUND");
      expect(await app.deps.repos.jobs.get(tenantA, jobId)).toMatchObject({ status: "failed" });
    });

    it("rejects a missing jobId as a validation error envelope", async () => {
      const client = await app.connect(keyEditor);
      const res = await client.callTool({ name: "studix_retry_job", arguments: {} });
      expect(res.isError).toBe(true);
    });
  });

  describe("the job:retry scope", () => {
    it("forbids an API key without job:retry on the MCP tool and leaves the job failed", async () => {
      const secret = (
        await app.deps.apiKeys.create(tenantA, {
          name: "no-retry",
          scopes: ["workspace:read", "project:read", "job:cancel"],
        })
      ).secret;
      const jobId = await failedJobIn(tenantA);
      const client = await app.connect(secret);
      const res = await call(client, "studix_retry_job", { jobId });
      expect(res.isError).toBe(true);
      expect(res.envelope).toMatchObject({
        status: "error",
        data: null,
        error: { code: "FORBIDDEN", message: "Missing permission job:retry" },
      });
      expect(await app.deps.repos.jobs.get(tenantA, jobId)).toMatchObject({ status: "failed" });
    });

    it("lets an API key that holds job:retry requeue the job over MCP", async () => {
      const secret = (
        await app.deps.apiKeys.create(tenantA, {
          name: "with-retry",
          scopes: ["workspace:read", "project:read", "job:retry"],
        })
      ).secret;
      const jobId = await failedJobIn(tenantA);
      const client = await app.connect(secret);
      const res = await call(client, "studix_retry_job", { jobId });
      expect(res.isError).toBe(false);
      expect(res.envelope).toMatchObject({ status: "ok", data: { id: jobId, status: "queued" } });
    });
  });
});
