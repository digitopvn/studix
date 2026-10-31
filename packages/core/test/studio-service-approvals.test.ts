import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createInMemoryStudio, testTenant, withActor } from "../src/testing/index.ts";

const brief = { prompt: "Brand intro" };

async function rejects(promise: Promise<unknown>): Promise<StudixError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StudixError) return err;
    throw err;
  }
  throw new Error("expected a StudixError");
}

async function setup() {
  const env = createInMemoryStudio();
  const ctx = testTenant();
  const { project } = await env.studio.createVideoProject(ctx, { brief });
  return { ...env, ctx, project };
}

describe("publish without approval is blocked", () => {
  it("throws APPROVAL_REQUIRED, opens one pending request and audits the block", async () => {
    const { studio, repos, ctx, project } = await setup();
    const publish = { action: "publish" as const, subjectType: "project" as const, subjectId: project.id };
    const first = await rejects(studio.ensureApproved(ctx, publish));
    expect(first.code).toBe("APPROVAL_REQUIRED");
    expect(first.retryable).toBe(false);
    expect(first.details?.approvalId).toMatch(/^apr_/);
    const second = await rejects(studio.ensureApproved(ctx, publish));
    expect(second.details?.approvalId).toBe(first.details?.approvalId);
    const audit = await repos.audit.list(ctx, { subjectId: project.id });
    expect(audit.items.filter((e) => e.action === "approval.blocked")).toHaveLength(2);
  });

  it("passes once a signed-in reviewer approves", async () => {
    const { studio, ctx, project } = await setup();
    const publish = { action: "publish" as const, subjectType: "project" as const, subjectId: project.id };
    const blocked = await rejects(studio.ensureApproved(ctx, publish));
    const reviewer = withActor(ctx, { type: "user", id: "usr_rev", role: "reviewer" });
    await studio.approve(reviewer, { approvalId: String(blocked.details?.approvalId), decision: "approved" });
    const result = await studio.ensureApproved(ctx, publish);
    expect(result.required).toBe(true);
    expect(result.approval?.status).toBe("approved");
  });

  it("API keys and system actors cannot approve a publish", async () => {
    const { studio, ctx, project } = await setup();
    const blocked = await rejects(
      studio.ensureApproved(ctx, { action: "publish", subjectType: "project", subjectId: project.id }),
    );
    const approvalId = String(blocked.details?.approvalId);
    const agentKey = withActor(ctx, { type: "apiKey", id: "key_1", scopes: ["approval:decide"] });
    expect((await rejects(studio.approve(agentKey, { approvalId, decision: "approved" }))).code).toBe(
      "FORBIDDEN",
    );
    const worker = withActor(ctx, { type: "system", id: "worker" });
    expect((await rejects(studio.approve(worker, { approvalId, decision: "approved" }))).code).toBe(
      "FORBIDDEN",
    );
  });

  it("a rejected publish stays blocked", async () => {
    const { studio, ctx, project } = await setup();
    const publish = { action: "publish" as const, subjectType: "project" as const, subjectId: project.id };
    const blocked = await rejects(studio.ensureApproved(ctx, publish));
    await studio.approve(ctx, {
      approvalId: String(blocked.details?.approvalId),
      decision: "rejected",
      comment: "logo",
    });
    const err = await rejects(studio.ensureApproved(ctx, publish));
    expect(err.code).toBe("FORBIDDEN");
    expect(err.details?.comment).toBe("logo");
  });

  it("requires the publish permission to even attempt it", async () => {
    const { studio, ctx, project } = await setup();
    const editor = withActor(ctx, { type: "user", id: "usr_ed", role: "editor" });
    const err = await rejects(
      studio.ensureApproved(editor, { action: "publish", subjectType: "project", subjectId: project.id }),
    );
    expect(err.code).toBe("FORBIDDEN");
  });

  it("a publish job parked by the worker shows its pending publish approval", async () => {
    const { studio, repos, ctx } = await setup();
    const { job } = await repos.queue.enqueue(ctx, {
      kind: "video.publish",
      payload: { renderId: "rnd_1", title: "t" },
      createdBy: { type: "user", id: "u" },
    });
    await repos.jobs.update(ctx, job.id, { status: "waiting_approval" });
    const approval = await repos.approvals.create(ctx, {
      action: "publish",
      subject: { type: "job", id: job.id },
      reason: "publishing needs a human",
      requestedBy: { type: "system", id: "worker" },
    });
    const view = await studio.getJob(ctx, job.id);
    expect(view.approval).toMatchObject({ id: approval.id, action: "publish", status: "pending" });
    expect(view.next[0]).toMatchObject({ tool: "studix_get_job", arguments: { jobId: job.id } });
  });

  it("does not gate cheap actions", async () => {
    const { studio, ctx, project } = await setup();
    const result = await studio.ensureApproved(ctx, {
      action: "render.final",
      subjectType: "project",
      subjectId: project.id,
      estimatedCostCents: 5,
    });
    expect(result).toEqual({ required: false });
  });
});

describe("cross-tenant isolation", () => {
  it("other workspaces see NOT_FOUND for every id-based read and write", async () => {
    const { studio, ctx, project } = await setup();
    const { job } = await studio.createVideoProject(ctx, { brief, budgetCents: 1 });
    const blocked = await rejects(
      studio.ensureApproved(ctx, { action: "publish", subjectType: "project", subjectId: project.id }),
    );
    const approvalId = String(blocked.details?.approvalId);

    const sameOrgOtherWs = testTenant({ organizationId: ctx.organizationId });
    const otherOrgSameWsId = testTenant({ workspaceId: ctx.workspaceId });
    for (const intruder of [sameOrgOtherWs, otherOrgSameWsId]) {
      expect((await rejects(studio.getProject(intruder, project.id))).code).toBe("NOT_FOUND");
      expect((await rejects(studio.getJob(intruder, job.id))).code).toBe("NOT_FOUND");
      expect((await rejects(studio.cancelJob(intruder, job.id))).code).toBe("NOT_FOUND");
      expect((await rejects(studio.approve(intruder, { approvalId, decision: "approved" }))).code).toBe(
        "NOT_FOUND",
      );
      expect(
        (
          await rejects(
            studio.requestApproval(intruder, {
              action: "publish",
              subjectType: "project",
              subjectId: project.id,
            }),
          )
        ).code,
      ).toBe("NOT_FOUND");
      expect(
        (
          await rejects(
            studio.ensureApproved(intruder, {
              action: "publish",
              subjectType: "project",
              subjectId: project.id,
            }),
          )
        ).code,
      ).toBe("NOT_FOUND");
      expect((await studio.listProjects(intruder)).items).toEqual([]);
      expect((await studio.listAssets(intruder)).items).toEqual([]);
    }
    expect((await studio.getJob(ctx, job.id)).status).toBe("queued");
  });
});

describe("jobs, lists and audit", () => {
  it("cancels queued jobs and records the request", async () => {
    const { studio, repos, ctx } = await setup();
    const { job } = await studio.createVideoProject(ctx, { brief });
    const cancelled = await studio.cancelJob(ctx, job.id, "changed my mind");
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelRequested: true,
      error: { code: "CANCELLED" },
    });
    const audit = await repos.audit.list(ctx, { subjectType: "job", subjectId: job.id });
    expect(audit.items[0]).toMatchObject({
      action: "job.cancel_requested",
      data: { reason: "changed my mind" },
    });
  });

  it("retries a failed job as the same job, audits it and refuses other states and roles", async () => {
    const { studio, repos, ctx } = await setup();
    const { job } = await studio.createVideoProject(ctx, { brief });
    await expect(studio.retryJob(ctx, job.id)).rejects.toMatchObject({ code: "CONFLICT" });

    await repos.jobs.update(ctx, job.id, {
      status: "failed",
      attempts: 3,
      error: { code: "UNAVAILABLE", message: "bucket missing", retryable: false },
      finishedAt: new Date(),
    });
    const failed = await studio.getJob(ctx, job.id);
    expect(failed.next.map((n) => n.tool)).toContain("studix_retry_job");

    const viewer = { ...ctx, actor: { type: "user" as const, id: "usr_v", role: "viewer" as const } };
    await expect(studio.retryJob(viewer, job.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const retried = await studio.retryJob(ctx, job.id);
    expect(retried).toMatchObject({ id: job.id, status: "queued", attempts: 3 });
    expect(retried.error).toBeUndefined();
    expect(retried.maxAttempts).toBeGreaterThan(3);
    const audit = await repos.audit.list(ctx, { subjectType: "job", subjectId: job.id });
    expect(audit.items[0]).toMatchObject({ action: "job.retried", data: { error: "UNAVAILABLE" } });
  });

  it("does not retry a failed publish job", async () => {
    const { studio, repos, ctx } = await setup();
    const { queue } = repos;
    const { job } = await queue.enqueue(ctx, { kind: "video.publish", payload: {}, createdBy: ctx.actor });
    await repos.jobs.update(ctx, job.id, { status: "failed" });
    await expect(studio.retryJob(ctx, job.id)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await studio.getJob(ctx, job.id)).next.map((n) => n.tool)).not.toContain("studix_retry_job");
  });

  it("asks running jobs to stop instead of killing them", async () => {
    const { studio, repos, ctx } = await setup();
    const { job } = await studio.createVideoProject(ctx, { brief });
    await repos.jobs.update(ctx, job.id, { status: "running", stage: "plan" });
    const view = await studio.cancelJob(ctx, job.id);
    expect(view).toMatchObject({ status: "running", cancelRequested: true });
  });

  it("paginates projects newest first", async () => {
    const { studio, ctx } = await setup();
    for (let i = 0; i < 4; i++) await studio.createVideoProject(ctx, { brief: { prompt: `p${i}` } });
    const page1 = await studio.listProjects(ctx, { limit: 2 });
    expect(page1.items.map((p) => p.title)).toEqual(["p3", "p2"]);
    const page2 = await studio.listProjects(ctx, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((p) => p.title)).toEqual(["p1", "p0"]);
    const page3 = await studio.listProjects(ctx, { limit: 2, cursor: page2.nextCursor });
    expect(page3).toEqual({ items: [{ ...page3.items[0]!, title: "Brand intro" }] });
  });

  it("lists assets scoped by project", async () => {
    const { studio, repos, ctx, project } = await setup();
    const asset = await repos.assets.create(ctx, {
      projectId: project.id,
      kind: "image",
      name: "logo.png",
      createdBy: { type: "user", id: "u" },
    });
    await repos.assets.addVersion(ctx, {
      assetId: asset.id,
      storageKey: `assets/${asset.id}/v1/logo.png`,
      sha256: "a".repeat(64),
      mime: "image/png",
      bytes: 10,
      provenance: { source: "upload" },
      createdBy: { type: "user", id: "u" },
    });
    const page = await studio.listAssets(ctx, { projectId: project.id });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.currentVersionId).toMatch(/^astv_/);
    expect((await studio.listAssets(ctx, { projectId: "prj_other" })).items).toEqual([]);
  });

  it("records validated audit events with the context actor", async () => {
    const { studio, ctx } = await setup();
    const event = await studio.recordAudit(ctx, {
      action: "render.downloaded",
      subjectType: "render",
      subjectId: "rnd_1",
    });
    expect(event).toMatchObject({
      actor: { type: ctx.actor.type, id: ctx.actor.id },
      workspaceId: ctx.workspaceId,
    });
    expect((await rejects(studio.recordAudit(ctx, { action: "Bad Action", subjectType: "x" }))).code).toBe(
      "VALIDATION",
    );
  });
});
