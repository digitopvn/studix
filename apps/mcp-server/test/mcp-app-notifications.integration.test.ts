import { randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { createSecretBox } from "@studix/auth";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobWebhookService } from "../src/job-webhooks.ts";
import { REVIEW_APP_URI } from "../src/mcp/review-app.ts";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: Record<string, unknown> | null;
  error?: { code: string };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

describe("MCP review app, job resource and webhook (Postgres)", () => {
  let app: TestApp;
  let editor: Client;
  let other: Client;
  let admin: Client;
  let job: { projectId: string; jobId: string };

  beforeAll(async () => {
    app = await startTestApp();
    app.deps.webhooks = createJobWebhookService({
      repo: app.db.repos.workspaceWebhooks,
      secrets: createSecretBox(randomBytes(32)),
      logger: app.deps.logger,
      allowLocal: false,
    });
    const a = await app.provisionTenant("app-a");
    const b = await app.provisionTenant("app-b");
    editor = await app.connect(await app.createKey(a));
    other = await app.connect(await app.createKey(b));
    admin = await app.connect(await app.createKey(a, "admin"));
    const created = await call(editor, "studix_create_video", {
      prompt: "Review app intro",
      spec: brandIntro,
    });
    job = created.data as typeof job;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("links create_video and get_job to the review app, served as an MCP App resource", async () => {
    const { tools } = await editor.listTools();
    const getJob = tools.find((t) => t.name === "studix_get_job");
    expect(getJob?._meta).toMatchObject({
      ui: { resourceUri: REVIEW_APP_URI },
      "openai/outputTemplate": REVIEW_APP_URI,
    });
    expect(tools.find((t) => t.name === "studix_review")?._meta).toMatchObject({
      ui: { visibility: ["app"] },
    });

    const read = await editor.readResource({ uri: REVIEW_APP_URI });
    const content = read.contents[0] as { mimeType: string; text: string };
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("ui/initialize");
  });

  it("serves review data and the job resource to its own workspace only", async () => {
    const review = await call(editor, "studix_review", { projectId: job.projectId });
    expect(review.status).toBe("ok");
    expect(review.data).toMatchObject({ projectId: job.projectId, notes: [] });

    const uri = `studix://jobs/${job.jobId}`;
    const read = await editor.readResource({ uri });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toMatchObject({ id: job.jobId });
    await expect(other.readResource({ uri })).rejects.toThrow();
  });

  it("waits for a job with progress notifications", async () => {
    const progress: number[] = [];
    const result = await editor.callTool(
      { name: "studix_get_job", arguments: { jobId: job.jobId, waitSeconds: 1 } },
      { onprogress: (p) => void progress.push(p.progress) },
    );
    expect((result.structuredContent as unknown as Envelope).status).toBe("ok");
    expect(progress.length).toBeGreaterThan(0);
  });

  it("limits webhooks to admins, refuses private addresses and keeps the secret out of reads", async () => {
    const denied = await call(editor, "studix_webhook", { action: "set", url: "https://example.com/hook" });
    expect(denied.error?.code).toBe("FORBIDDEN");
    const bad = await call(admin, "studix_webhook", { action: "set", url: "http://127.0.0.1:9/hook" });
    expect(bad.error?.code).toBe("VALIDATION");
    const got = await call(admin, "studix_webhook", { action: "get" });
    expect(got.data).toEqual({ webhook: null });
  });
});
