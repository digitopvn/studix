import type { TenantContext } from "@studix/core";
import type { VideoIR } from "@studix/video-ir";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

interface MeBody {
  user: { id: string };
  organization: { id: string };
  workspace: { id: string };
}

describe("dashboard project review API (Postgres)", () => {
  let app: TestApp;
  let alice: string;
  let bob: string;
  let carol: string;
  let aliceCtx: TenantContext;

  /** A request in another workspace the caller belongs to (the dashboard sends this header). */
  function inWorkspace(cookie: string, method: string, path: string, body?: unknown) {
    return fetch(`${app.base}${path}`, {
      method,
      headers: {
        origin: app.base,
        cookie,
        "x-studix-workspace": aliceCtx.workspaceId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function me(cookie: string): Promise<MeBody> {
    return (await app.api("GET", "/api/me", { cookie })).json();
  }

  async function projectWithSpec(): Promise<string> {
    const created = await app.deps.studio.createVideoProject(aliceCtx, {
      brief: { prompt: "Video giới thiệu Sương Mai" },
      spec: brandIntro as VideoIR,
    });
    return created.project.id;
  }

  beforeAll(async () => {
    app = await startTestApp();
    const stamp = Date.now();
    alice = await app.signUp(`alice-review-${stamp}@example.test`);
    bob = await app.signUp(`bob-review-${stamp}@example.test`);
    carol = await app.signUp(`carol-review-${stamp}@example.test`);
    const a = await me(alice);
    aliceCtx = {
      organizationId: a.organization.id,
      workspaceId: a.workspace.id,
      actor: { type: "user", id: a.user.id, role: "owner" },
    };
    const c = await me(carol);
    await app.db.repos.workspaces.upsertMember(aliceCtx, { userId: c.user.id, role: "reviewer" });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("shows script, storyboard by scene and shot, timeline, versions and cost with separate render and approval", async () => {
    const projectId = await projectWithSpec();
    const res = await app.api("GET", `/api/projects/${projectId}/review`, { cookie: alice });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const review = await res.json();
    expect(review).toMatchObject({
      workflowTemplate: "brand-intro",
      currentVersion: { version: 1 },
      timeline: { durationMs: 15000, aspectRatio: "9:16" },
      storyboard: { revision: 0, approval: { status: "draft" }, pendingShots: 6 },
      cost: { spentCents: 0 },
    });
    expect(review.script.lines.length).toBeGreaterThan(0);
    expect(review.storyboard.scenes[2].shots[0]).toMatchObject({
      id: "feature-1",
      pointer: "/scenes/2/shots/0",
      render: "not_rendered",
      approval: { status: "draft" },
    });
    expect(review.cost.jobs).toHaveLength(1);
  });

  it("a reviewer approves shots and the storyboard; comments are listed per shot", async () => {
    const projectId = await projectWithSpec();
    const shot = await inWorkspace(carol, "POST", `/api/projects/${projectId}/storyboard/decision`, {
      target: "shot",
      targetId: "hook-title",
      decision: "changes_requested",
      note: "Chữ to hơn",
      expectedRevision: 0,
    });
    expect(shot.status).toBe(200);
    expect(await shot.json()).toMatchObject({
      storyboard: { revision: 1 },
      comment: { targetId: "shot:hook-title" },
    });

    const blocked = await inWorkspace(carol, "POST", `/api/projects/${projectId}/storyboard/decision`, {
      target: "storyboard",
      decision: "approved",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: "CONFLICT", details: { shots: ["hook-title"] } },
    });

    const stale = await inWorkspace(carol, "POST", `/api/projects/${projectId}/storyboard/decision`, {
      target: "shot",
      targetId: "hook-title",
      decision: "approved",
      expectedRevision: 0,
    });
    expect(stale.status).toBe(409);

    for (const body of [
      { target: "shot", targetId: "hook-title", decision: "approved" },
      { target: "storyboard", decision: "approved" },
    ]) {
      expect(
        (await inWorkspace(carol, "POST", `/api/projects/${projectId}/storyboard/decision`, body)).status,
      ).toBe(200);
    }
    const comment = await inWorkspace(carol, "POST", `/api/projects/${projectId}/feedback`, {
      shotId: "intro-logo",
      comment: "Logo đẹp",
    });
    expect(comment.status).toBe(201);

    const review = await (
      await app.api("GET", `/api/projects/${projectId}/review`, { cookie: alice })
    ).json();
    expect(review.storyboard.approval.status).toBe("approved");
    expect(review.storyboard.scenes[0].shots[0]).toMatchObject({
      approval: { status: "approved" },
      comments: 1,
    });
    expect(review.storyboard.scenes[1].shots[0]).toMatchObject({ comments: 1, render: "not_rendered" });
  });

  it("a reviewer cannot patch or render; the owner can, and invalid bodies are rejected at the boundary", async () => {
    const projectId = await projectWithSpec();
    const patch = { ops: [{ op: "replace", path: "/scenes/0/shots/0/text", value: "Xin chào" }] };
    const denied = await inWorkspace(carol, "POST", `/api/projects/${projectId}/feedback`, {
      shotId: "hook-title",
      comment: "Đổi câu",
      patch,
    });
    expect(denied.status).toBe(403);
    expect((await inWorkspace(carol, "POST", `/api/projects/${projectId}/render`, {})).status).toBe(403);

    const patched = await app.api("POST", `/api/projects/${projectId}/feedback`, {
      cookie: alice,
      body: { shotId: "hook-title", comment: "Đổi câu", patch },
    });
    expect(patched.status).toBe(201);
    expect(await patched.json()).toMatchObject({
      version: 2,
      invalidated: expect.arrayContaining(["shot:hook-title"]),
    });
    const rendered = await app.api("POST", `/api/projects/${projectId}/render`, {
      cookie: alice,
      body: { renderPreset: "preview" },
    });
    expect(rendered.status).toBe(201);
    expect(await rendered.json()).toMatchObject({ version: 2, job: { status: "queued" } });

    for (const body of [{ comment: "no target" }, { shotId: "a", sceneId: "b", comment: "two targets" }]) {
      const res = await app.api("POST", `/api/projects/${projectId}/feedback`, { cookie: alice, body });
      expect(res.status).toBe(400);
    }
    const badDecision = await app.api("POST", `/api/projects/${projectId}/storyboard/decision`, {
      cookie: alice,
      body: { target: "shot", decision: "approved" },
    });
    expect(badDecision.status).toBe(400);
    const badPack = await app.api("POST", "/api/projects", {
      cookie: alice,
      body: { prompt: "x", workflowTemplate: "missing-pack" },
    });
    expect(badPack.status).toBe(400);
    expect(await badPack.json()).toMatchObject({
      error: { details: { available: ["brand-intro", "marketing-video", "motion-graphic"] } },
    });
  });

  it("keeps the review, decisions, feedback and render of another tenant's project invisible", async () => {
    const projectId = await projectWithSpec();
    const calls: Array<[string, string, unknown]> = [
      ["GET", `/api/projects/${projectId}/review`, undefined],
      [
        "POST",
        `/api/projects/${projectId}/storyboard/decision`,
        { target: "storyboard", decision: "approved" },
      ],
      ["POST", `/api/projects/${projectId}/feedback`, { shotId: "hook-title", comment: "x" }],
      ["POST", `/api/projects/${projectId}/render`, {}],
    ];
    for (const [method, path, body] of calls) {
      const res = await app.api(method, path, { cookie: bob, body });
      expect(res.status).toBe(404);
    }
    const review = await (
      await app.api("GET", `/api/projects/${projectId}/review`, { cookie: alice })
    ).json();
    expect(review.comments).toEqual([]);
    expect(review.storyboard.approval.status).toBe("draft");
  });
});
