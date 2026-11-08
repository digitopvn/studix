import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApiKeyService } from "@studix/auth";
import type { TenantContext } from "@studix/core";
import { createTestDatabase, type TestDatabase } from "@studix/database/testing";
import { type MockMcpServer, startMockMcpServer } from "@studix/mock-mcp";
import { FfmpegProbe, renderToolchain } from "@studix/renderers";
import type { VideoIR } from "@studix/video-ir";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ComposedApp, composeApp } from "../src/compose-app.ts";
import { AGENT_HANDOFF_MCP_TOOLS } from "../src/mcp/agent-handoff-tools.ts";
import { COMPOSITION_MCP_TOOLS } from "../src/mcp/composition-tools.ts";
import { WEBHOOK_MCP_TOOLS } from "../src/mcp/job-notifications.ts";
import { LOG_MCP_TOOLS } from "../src/mcp/log-tools.ts";
import { MEDIA_EXEC_MCP_TOOLS } from "../src/mcp/media-exec-tool.ts";
import { NATIVE_TOOLS } from "../src/mcp/native-tools.ts";
import { REVIEW_APP_TOOLS } from "../src/mcp/review-app.ts";
import { SKILL_MCP_TOOLS } from "../src/mcp/skill-tools.ts";
import { freePort } from "./app-test-harness.ts";
import { callTool, type JobData, pollJob, startWorker, type WorkerHandle } from "./e2e-video-harness.ts";

/**
 * Full product path with real services: app composed from env (Postgres, MinIO signer, MCP gateway), the
 * worker as a separate OS process (HyperFrames + FFmpeg render, S3 upload), a TS MCP SDK client over
 * Streamable HTTP, and the mock MCP server as a workspace connector. Planning uses the free rules route.
 */
const toolchain = renderToolchain();
const s3Ready = Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID);
if (!toolchain.ok) console.warn(`[e2e-video] skipped: ${toolchain.reason}`);

const PROMPT =
  "Video giới thiệu thương hiệu cà phê Sương Mai cho khách hàng trẻ, dài 6 giây, dọc.\n" +
  "Rang mới mỗi tuần. Giao tận nơi trong 24 giờ. Đặt ngay hôm nay!";
const META = ["studix_tool_execute", "studix_tool_inspect", "studix_tool_search"];

describe.skipIf(!toolchain.ok)("E2E video over MCP with a real worker process", () => {
  let db: TestDatabase;
  let mock: MockMcpServer;
  let composed: ComposedApp;
  let server: Server;
  let base: string;
  let client: Client;
  let tenant: TenantContext;
  let workDir: string;
  let workerEnv: Record<string, string>;
  /** Render produced by the main flow; the publish test gates it. */
  let publishRenderId = "";
  /** IR planned by the main flow; the timeout test stretches it into a long host-authored spec. */
  let plannedIr: VideoIR | undefined;
  const workers: WorkerHandle[] = [];
  const logs = () => workers.map((w) => w.logs()).join("\n---\n");
  const api = (method: string, path: string, cookie: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { origin: base, cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const worker = () => {
    const w = startWorker(workerEnv);
    workers.push(w);
    return w;
  };

  beforeAll(async () => {
    if (!s3Ready)
      throw new Error("S3_* is not set: run `docker compose up -d minio` (S3_BUCKET=studix-test)");
    db = await createTestDatabase();
    mock = await startMockMcpServer();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const insecure = `127.0.0.1:${mock.port}`;
    composed = await composeApp({
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DATABASE_URL: db.url,
      PORT: String(port),
      STUDIX_PUBLIC_URL: base,
      BETTER_AUTH_SECRET: "e2e-dashboard-secret-0123456789-abcdef",
      S3_SIGNED_URL_TTL_SECONDS: "600",
      STUDIX_MCP_GATEWAY_INSECURE_HOSTS: insecure,
    });
    server = await new Promise((resolve) => {
      const s = composed.app.listen(port, "127.0.0.1", () => resolve(s));
    });
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        email: `e2e-${Date.now()}@example.test`,
        password: "a-long-test-password",
        name: "e2e",
      }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const key = await api("POST", "/api/api-keys", cookie, { name: "e2e-agent" });
    const { secret } = (await key.json()) as { secret: string };
    tenant = await createApiKeyService({
      directory: db.repos.directory,
      apiKeys: db.repos.apiKeys,
      env: "test",
    }).authenticate(`Bearer ${secret}`);
    client = new Client({ name: "studix-e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );

    // (f) Connector added and refreshed through the dashboard API; only brand_lookup is granted.
    const added = await api("POST", "/api/connectors", cookie, {
      name: "brand",
      url: mock.url,
      toolPolicy: { allow: ["brand_lookup"] },
    });
    expect(added.status).toBe(201);
    const connector = (await added.json()) as { id: string; status: string };
    const tested = await (await api("POST", `/api/connectors/${connector.id}/test`, cookie)).json();
    expect(tested).toMatchObject({ ok: true });
    expect(tested.tools).toContain("brand.brand_lookup");

    workDir = await mkdtemp(join(tmpdir(), "studix-e2e-"));
    workerEnv = {
      DATABASE_URL: db.url,
      WORKER_HEALTH_PORT: "0",
      WORKER_HEALTH_HOST: "127.0.0.1",
      WORKER_POLL_INTERVAL_MS: "200",
      WORKER_SHUTDOWN_GRACE_MS: "2000",
      WORKER_CONCURRENCY: "2",
      WORKER_WORK_DIR: workDir,
      JOB_LEASE_SECONDS: "5",
      RENDER_COST_CENTS_PER_SECOND: "1",
      DECISION_PROVIDERS: "rules",
      STUDIX_BRAND_LOOKUP_TOOL: "brand.brand_lookup",
      STUDIX_MCP_GATEWAY_INSECURE_HOSTS: insecure,
    };
    worker();
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(workers.map((w) => w.stop(5_000)));
    await client?.close().catch(() => {});
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    server?.closeAllConnections();
    await composed?.close();
    await mock?.close();
    await db?.destroy();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 60_000);

  it("(f) lists only native, handoff, skill and meta tools, then searches, inspects and executes a connector tool", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect([...names].sort()).toEqual(
      [
        ...NATIVE_TOOLS,
        ...AGENT_HANDOFF_MCP_TOOLS,
        ...SKILL_MCP_TOOLS,
        ...MEDIA_EXEC_MCP_TOOLS,
        ...COMPOSITION_MCP_TOOLS,
        ...REVIEW_APP_TOOLS,
        ...WEBHOOK_MCP_TOOLS,
        ...LOG_MCP_TOOLS,
      ]
        .map((t) => t.name)
        .concat(META)
        .sort(),
    );

    const search = await callTool(client, "studix_tool_search", { query: "brand" });
    expect(search.status).toBe("ok");
    const hits = search.data?.results as { tool: string }[];
    expect(hits.map((h) => h.tool)).toContain("brand.brand_lookup");
    const inspect = await callTool(client, "studix_tool_inspect", { tool: "brand.brand_lookup" });
    expect(inspect.status).toBe("ok");
    const exec = await callTool(client, "studix_tool_execute", {
      tool: "brand.brand_lookup",
      arguments: { name: "Sương Mai" },
    });
    expect(exec.status, JSON.stringify(exec.error)).toBe("ok");
    const result = exec.data?.result as { structuredContent: { colors: { primary: string } } };
    expect(result.structuredContent.colors.primary).toBe("#5B3A29");
    const denied = await callTool(client, "studix_tool_execute", {
      tool: "brand.echo",
      arguments: { text: "x" },
    });
    expect(denied.status).toBe("error");
  });

  it("renders a Vietnamese prompt to an h264 MP4, surviving a worker crash mid-render without re-planning", async () => {
    const created = await callTool(client, "studix_create_video", {
      prompt: PROMPT,
      renderPreset: "preview",
    });
    expect(created.status, JSON.stringify(created.error)).toBe("ok");
    const jobId = String(created.data?.jobId);

    await pollJob(client, jobId, (j) => j.status === "running" && j.stage === "render", 60_000, logs);
    workers[0]!.crash();
    worker();
    const done = await pollJob(
      client,
      jobId,
      (j) => ["succeeded", "failed"].includes(j.status),
      150_000,
      logs,
    );
    expect(done.status, JSON.stringify(done.error)).toBe("succeeded");
    expect(done.attempts).toBeGreaterThanOrEqual(2);
    // Stage rows are per attempt: plan ran once (attempt 1), render ran again after the crash.
    expect(done.stages.filter((s) => s.name === "plan").map((s) => s.attempt)).toEqual([1]);
    expect(Math.max(...done.stages.filter((s) => s.name === "render").map((s) => s.attempt))).toBeGreaterThan(
      1,
    );
    const usage = (await db.repos.usage.list(tenant, { limit: 100 })).items.filter((u) => u.jobId === jobId);
    expect(usage.filter((u) => u.kind === "provider.decision")).toHaveLength(1);
    expect(usage.find((u) => u.kind === "provider.decision")?.metadata).toMatchObject({
      provider: "rules",
      operation: "video.brief",
    });

    const project = await db.repos.projects.get(tenant, String(created.data?.projectId));
    const version = await db.repos.projects.getVersion(tenant, project!.currentVersionId!);
    expect(version?.ir.brand?.name).toBe("Sương Mai");
    expect(version?.ir.brand?.palette.primary).toBe("#5B3A29");
    expect(mock.invocations("brand_lookup")).toBeGreaterThanOrEqual(2);

    expect(done.video?.url).toMatch(/^http/);
    const res = await fetch(done.video!.url);
    expect(res.status).toBe(200);
    const file = join(workDir, "download.mp4");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const probe = await new FfmpegProbe({ ffprobePath: process.env.FFPROBE_PATH }).probe(file);
    expect(probe.videoCodec).toBe("h264");
    expect(Math.abs(probe.durationMs - 6000)).toBeLessThan(250);
    publishRenderId = String(done.video!.renderId);
    plannedIr = version?.ir;
  });

  it("(b) replays the same job for an idempotency key and (c) cancels it", async () => {
    const args = { prompt: PROMPT, renderPreset: "preview", idempotencyKey: `e2e-${Date.now()}` };
    const first = await callTool(client, "studix_create_video", args);
    const second = await callTool(client, "studix_create_video", args);
    expect(second.data).toMatchObject({ jobId: first.data?.jobId, replayed: true });
    const jobId = String(first.data?.jobId);
    const cancel = await callTool(client, "studix_cancel_job", { jobId, reason: "e2e" });
    expect(cancel.status, JSON.stringify(cancel.error)).toBe("ok");
    const job = await pollJob(client, jobId, (j) => j.status === "cancelled", 60_000, logs);
    expect(job.error?.code).toBe("CANCELLED");
  });

  it("(d) reports deadline timeouts and exceeded budgets as job errors with a suggested action", async () => {
    // A 60s host-authored spec (the last scene held longer) cannot render within a 10s deadline.
    expect(plannedIr).toBeDefined();
    const ir = structuredClone(plannedIr!);
    const extraMs = 60_000 - ir.format.durationMs;
    ir.scenes[ir.scenes.length - 1]!.durationMs += extraMs;
    ir.format.durationMs += extraMs;
    const slow = await callTool(client, "studix_create_video", {
      prompt: PROMPT,
      spec: ir,
      renderPreset: "preview",
      deadlineSeconds: 10,
    });
    expect(slow.status, JSON.stringify(slow.error)).toBe("ok");
    const poor = await callTool(client, "studix_create_video", {
      prompt: PROMPT,
      renderPreset: "preview",
      budgetCents: 1,
    });
    const isFinal = (j: JobData) => ["failed", "succeeded", "cancelled"].includes(j.status);
    const [timedOut, overBudget] = await Promise.all([
      pollJob(client, String(slow.data?.jobId), isFinal, 60_000, logs),
      pollJob(client, String(poor.data?.jobId), isFinal, 60_000, logs),
    ]);
    expect(timedOut).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    expect(timedOut.error?.suggestedAction).toBeTruthy();
    expect(overBudget).toMatchObject({ status: "failed", error: { code: "BUDGET_EXCEEDED" } });
    expect(overBudget.error?.suggestedAction).toBeTruthy();
  });

  it("(e) blocks publishing until a human approves; an agent key cannot approve", async () => {
    expect(publishRenderId).not.toBe("");
    const { job } = await db.repos.queue.enqueue(tenant, {
      kind: "video.publish",
      payload: { renderId: publishRenderId, title: "Sương Mai" },
      createdBy: { type: "apiKey", id: tenant.actor.id },
    });
    const parked = await pollJob(client, job.id, (j) => j.status === "waiting_approval", 30_000, logs);
    expect(parked.approval).toMatchObject({ action: "publish", status: "pending" });
    const approve = await callTool(client, "studix_approve", {
      approvalId: parked.approval!.id,
      decision: "approved",
    });
    expect(approve.error?.code).toBe("FORBIDDEN");
    const still = await pollJob(client, job.id, () => true, 5_000);
    expect(still.status).toBe("waiting_approval");
  });
});
