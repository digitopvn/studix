import type { Client } from "@modelcontextprotocol/client";
import type { TenantContext } from "@studix/core";
import { getSkill, registerPack, type WorkflowPack } from "@studix/skills";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface Envelope {
  status: "ok" | "error";
  data: Record<string, unknown> | null;
  next: { tool: string; arguments?: Record<string, unknown> }[];
  error?: { code: string; message: string; details?: Record<string, unknown>; suggestedAction?: string };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, envelope: result.structuredContent as unknown as Envelope };
}

/** A pack the server was never changed for: registering it is enough for create_video to accept it. */
const explainerPack: WorkflowPack = {
  id: "review-explainer",
  title: "Review explainer",
  version: 1,
  templates: [{ ...getSkill("brand-intro"), id: "review-explainer", title: "Review explainer" }],
};

describe("MCP workflow templates, feedback and render (Postgres)", () => {
  let app: TestApp;
  let tenantA: TenantContext;
  let tenantB: TenantContext;
  let editor: Client;
  let other: Client;
  let unregister: (() => void) | undefined;

  beforeAll(async () => {
    app = await startTestApp();
    tenantA = await app.provisionTenant("review-a");
    tenantB = await app.provisionTenant("review-b");
    editor = await app.connect(await app.createKey(tenantA));
    other = await app.connect(await app.createKey(tenantB));
  });
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });
  afterAll(async () => {
    await app?.close();
  });

  async function createFromSpec(client: Client) {
    const created = await call(client, "studix_create_video", {
      prompt: "Sương Mai brand intro",
      spec: brandIntro,
    });
    expect(created.envelope.status).toBe("ok");
    return created.envelope.data as { projectId: string; jobId: string; reviewUrl: string };
  }

  it("create_video defaults to brand-intro and returns the review URL", async () => {
    const { envelope } = await call(editor, "studix_create_video", { prompt: "Brand intro for Acme" });
    expect(envelope.data).toMatchObject({ workflowTemplate: "brand-intro", status: "queued" });
    const projectId = envelope.data?.projectId as string;
    expect(envelope.data?.reviewUrl).toBe(`${app.base}/#/projects/${projectId}/review`);
    const job = await app.deps.repos.jobs.get(tenantA, envelope.data?.jobId as string);
    expect(job?.payload).toMatchObject({ workflowTemplate: "brand-intro" });
  });

  it("accepts a pack registered at runtime and rejects an unknown pack with the available ids", async () => {
    unregister = registerPack(explainerPack);
    const ok = await call(editor, "studix_create_video", {
      prompt: "Explain the product",
      workflowTemplate: "review-explainer",
    });
    expect(ok.envelope.data).toMatchObject({ workflowTemplate: "review-explainer" });
    const project = await app.db.repos.projects.get(tenantA, ok.envelope.data?.projectId as string);
    expect(project?.workflowTemplate).toBe("review-explainer");

    const before = await app.db.repos.projects.list(tenantA, { limit: 100 });
    const bad = await call(editor, "studix_create_video", { prompt: "x", workflowTemplate: "no-such-pack" });
    expect(bad.isError).toBe(true);
    expect(bad.envelope.error).toMatchObject({
      code: "VALIDATION",
      details: {
        workflowTemplate: "no-such-pack",
        available: [
          "brand-intro",
          "marketing-video",
          "motion-graphic",
          "anime",
          "long-form-film",
          "review-explainer",
        ],
      },
    });
    expect(bad.envelope.error?.suggestedAction).toContain("review-explainer");
    const after = await app.db.repos.projects.list(tenantA, { limit: 100 });
    expect(after.items).toHaveLength(before.items.length);

    const malformed = await call(editor, "studix_create_video", {
      prompt: "x",
      workflowTemplate: "Bad Pack!",
    });
    expect(malformed.isError).toBe(true);
  });

  it("feedback on a shot with a patch makes a new version, invalidates that shot only and queues a job", async () => {
    const { projectId } = await createFromSpec(editor);
    const { envelope } = await call(editor, "studix_feedback", {
      projectId,
      shotId: "feature-1",
      comment: "Nhấn mạnh tốc độ giao hàng",
      patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }] },
      idempotencyKey: "fb-1",
    });
    expect(envelope.status).toBe("ok");
    expect(envelope.data).toMatchObject({
      projectId,
      version: 2,
      status: "queued",
      shots: ["feature-1"],
      replayed: false,
      reviewUrl: `${app.base}/#/projects/${projectId}/review`,
    });
    expect([...((envelope.data?.invalidated ?? []) as string[])].sort()).toEqual([
      "scene:feature",
      "shot:feature-1",
    ]);
    const jobId = envelope.data?.jobId as string;
    expect(envelope.next[0]).toMatchObject({ tool: "studix_get_job", arguments: { jobId } });
    const job = await app.deps.repos.jobs.get(tenantA, jobId);
    expect(job?.payload).toMatchObject({
      versionId: envelope.data?.versionId,
      workflowTemplate: "brand-intro",
    });

    const replay = await call(editor, "studix_feedback", {
      projectId,
      shotId: "feature-1",
      comment: "Nhấn mạnh tốc độ giao hàng",
      patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }] },
      idempotencyKey: "fb-1",
    });
    expect(replay.envelope.data).toMatchObject({ jobId, replayed: true });
  });

  it("get_project includeFeedback returns annotated notes with the snapshot as an image block", async () => {
    const { projectId } = await createFromSpec(editor);
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const sent = await call(editor, "studix_feedback", {
      projectId,
      shotId: "feature-1",
      comment: "Logo too small",
      annotation: {
        priority: "must",
        region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        strokes: [
          {
            tool: "pen",
            points: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0.5 },
              { x: 1, y: 1 },
            ],
          },
        ],
        snapshot: png,
      },
      idempotencyKey: "fb-annotated",
    });
    expect(sent.envelope.status).toBe("ok");

    const result = await editor.callTool({
      name: "studix_get_project",
      arguments: { projectId, includeFeedback: true },
    });
    const content = result.content as Array<{ type: string; data?: string }>;
    const note = (result.structuredContent as unknown as Envelope).data?.feedback as Array<
      Record<string, any>
    >;
    expect(note[0]).toMatchObject({ comment: "Logo too small", snapshotImage: 1 });
    expect(note[0]?.annotation.snapshot).toBeUndefined();
    expect(note[0]?.annotation.strokes[0]).toMatchObject({ tool: "pen", points: 3 });
    expect(content[1]).toMatchObject({ type: "image", data: "iVBORw0KGgo=" });
  });

  it("WebMCP serves the MCP tool schemas and runs them for the signed-in session", async () => {
    const cookie = await app.signUp(`webmcp-${Date.now()}@example.test`);
    const listed = (await (await app.api("GET", "/api/webmcp/tools", { cookie })).json()) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    const mcp = new Map((await editor.listTools()).tools.map((t) => [t.name, t.inputSchema]));
    expect(listed.tools.map((t) => t.name)).toContain("studix_feedback");
    for (const t of listed.tools) expect(t.inputSchema).toEqual(mcp.get(t.name));
    expect((await app.api("POST", "/api/webmcp/tools/studix_nope", { cookie, body: {} })).status).toBe(404);

    const callWeb = async (name: string, body: unknown) =>
      (await (await app.api("POST", `/api/webmcp/tools/${name}`, { cookie, body })).json()) as {
        isError?: boolean;
        structuredContent: Envelope;
      };
    const created = await callWeb("studix_create_video", { prompt: "Web intro", spec: brandIntro });
    const projectId = created.structuredContent.data?.projectId as string;
    const bad = await callWeb("studix_feedback", { projectId, shotId: "nope", comment: "x" });
    expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: "NOT_FOUND" } } });

    const png = "data:image/png;base64,iVBORw0KGgo=";
    const sent = await callWeb("studix_feedback", {
      projectId,
      shotId: "feature-1",
      comment: "Brighter",
      annotation: { snapshot: png },
    });
    const feedbackId = sent.structuredContent.data?.feedbackId as string;
    const review = (await (await app.api("GET", `/api/projects/${projectId}/review`, { cookie })).json()) as {
      comments: Array<{ id: string; images?: number; annotation?: { snapshot?: string } }>;
    };
    const note = review.comments.find((c) => c.id === feedbackId);
    expect(note).toMatchObject({ images: 1 });
    expect(note?.annotation?.snapshot).toBeUndefined();
    const image = await app.api("GET", `/api/projects/${projectId}/feedback/${feedbackId}/image/0`, {
      cookie,
    });
    expect(image.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe("iVBORw0KGgo=");
  });

  it("feedback without a patch is a comment that tells the client which paths a patch may touch", async () => {
    const { projectId } = await createFromSpec(editor);
    const { envelope } = await call(editor, "studix_feedback", {
      projectId,
      shotId: "cta-button",
      comment: "CTA rõ hơn",
    });
    expect(envelope.data).toMatchObject({
      jobId: null,
      versionId: null,
      allowedPaths: ["/scenes/3/shots/0"],
    });
    expect(envelope.next[0]?.tool).toBe("studix_feedback");

    const outside = await call(editor, "studix_feedback", {
      projectId,
      shotId: "cta-button",
      comment: "x",
      patch: { ops: [{ op: "replace", path: "/title", value: "Khác" }] },
    });
    expect(outside.envelope.error).toMatchObject({ code: "VALIDATION", details: { outside: ["/title"] } });
    const unknown = await call(editor, "studix_feedback", { projectId, shotId: "nope", comment: "x" });
    expect(unknown.envelope.error?.code).toBe("NOT_FOUND");
  });

  it("render queues a job for the current version", async () => {
    const { projectId } = await createFromSpec(editor);
    const { envelope } = await call(editor, "studix_render", { projectId, renderPreset: "final" });
    expect(envelope.data).toMatchObject({ projectId, version: 1, status: "queued", replayed: false });
    expect(envelope.next[0]?.tool).toBe("studix_get_job");
    const job = await app.deps.repos.jobs.get(tenantA, envelope.data?.jobId as string);
    expect(job?.payload).toMatchObject({ renderPreset: "final" });
  });

  it("keeps another tenant's project invisible and a viewer key read-only", async () => {
    const { projectId } = await createFromSpec(editor);
    for (const [tool, args] of [
      ["studix_feedback", { projectId, shotId: "hook-title", comment: "x" }],
      ["studix_render", { projectId }],
    ] as const) {
      const { envelope } = await call(other, tool, args);
      expect(envelope.error?.code).toBe("NOT_FOUND");
    }
    const viewer = await app.connect(await app.createKey(tenantA, "viewer"));
    const denied = await call(viewer, "studix_feedback", { projectId, shotId: "hook-title", comment: "x" });
    expect(denied.envelope.error?.code).toBe("FORBIDDEN");
    expect((await call(viewer, "studix_render", { projectId })).envelope.error?.code).toBe("FORBIDDEN");
    const project = await call(viewer, "studix_get_project", { projectId });
    expect(project.envelope.data?.reviewUrl).toBe(`${app.base}/#/projects/${projectId}/review`);
  });
});
