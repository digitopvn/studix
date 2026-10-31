import { createDefaultApprovalPolicy, StudioService, type TenantContext } from "@studix/core";
import { systemClock } from "@studix/shared";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();

function studio() {
  return new StudioService({
    ...db.current.repos,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    clock: systemClock,
  });
}

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_1", role: "owner" },
  };
}

describe("StudioService over Postgres repositories", () => {
  it("creates a project with a client spec, replays idempotent calls and hides it from other tenants", async () => {
    const service = studio();
    const ctx = await tenant("svc-a");
    const other = await tenant("svc-b");
    const input = {
      brief: { prompt: "Giới thiệu Sương Mai Coffee", language: "vi" },
      spec: brandIntro,
      idempotencyKey: "mcp-req-1",
    };
    const created = await service.createVideoProject(ctx, input);
    expect(created.job).toMatchObject({ status: "queued", projectId: created.project.id });
    expect(created.project.currentVersionId).toMatch(/^pver_/);

    const replay = await service.createVideoProject(ctx, input);
    expect(replay).toMatchObject({
      replayed: true,
      job: { id: created.job.id },
      project: { id: created.project.id },
    });

    const details = await service.getProject(ctx, created.project.id);
    expect(details.currentVersion?.ir).toEqual(brandIntro);
    expect(details.jobs.map((j) => j.id)).toEqual([created.job.id]);

    await expect(service.getProject(other, created.project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getJob(other, created.job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await service.listProjects(other)).items).toEqual([]);
  });

  it("serializes concurrent feedback patches on the same base: one wins, the other gets CONFLICT", async () => {
    const service = studio();
    const ctx = await tenant("svc-race");
    const created = await service.createVideoProject(ctx, {
      brief: { prompt: "Giới thiệu Sương Mai Coffee", language: "vi" },
      spec: brandIntro,
    });
    const baseVersionId = created.project.currentVersionId;
    const send = (text: string) =>
      service.submitFeedback(ctx, {
        projectId: created.project.id,
        shotId: "feature-1",
        comment: `đổi thành ${text}`,
        baseVersionId,
        patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: text }] },
      });
    const results = await Promise.allSettled([send("Một"), send("Hai"), send("Ba")]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    for (const r of lost) expect(r.reason).toMatchObject({ code: "CONFLICT" });

    const versions = await db.current.repos.projects.listVersions(ctx, created.project.id);
    expect(versions.items).toHaveLength(2);
    const project = await db.current.repos.projects.get(ctx, created.project.id);
    expect(project?.currentVersionId).toBe(versions.items[0]?.id);
    expect(versions.items.filter((v) => v.parentVersionId === baseVersionId)).toHaveLength(1);
  });

  it("concurrent feedback retries with one key converge on one version, comment and job", async () => {
    const service = studio();
    const ctx = await tenant("svc-key-race");
    const created = await service.createVideoProject(ctx, {
      brief: { prompt: "Giới thiệu Sương Mai Coffee", language: "vi" },
      spec: brandIntro,
    });
    const send = () =>
      service.submitFeedback(ctx, {
        projectId: created.project.id,
        shotId: "feature-1",
        comment: "Nhấn mạnh tốc độ giao hàng",
        idempotencyKey: "fb-key-race",
        patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }] },
      });
    const results = await Promise.all([send(), send(), send()]);
    expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
    expect(new Set(results.map((r) => r.job?.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.feedbackId)).size).toBe(1);

    const versions = await db.current.repos.projects.listVersions(ctx, created.project.id);
    expect(versions.items).toHaveLength(2);
    const comments = await db.current.repos.reviews.list(ctx, { projectId: created.project.id });
    expect(comments.items).toHaveLength(1);
    // A later retry replays from the job.
    expect(await send()).toMatchObject({ replayed: true, versionId: results[0]?.versionId });
  });

  it("finishes a feedback whose version was stored but whose comment and job were not", async () => {
    const service = studio();
    const ctx = await tenant("svc-orphan");
    const created = await service.createVideoProject(ctx, {
      brief: { prompt: "Giới thiệu Sương Mai Coffee", language: "vi" },
      spec: brandIntro,
    });
    const repos = db.current.repos;
    const base = await repos.projects.getVersion(ctx, created.project.currentVersionId ?? "");
    const ir = structuredClone(base!.ir);
    (ir.scenes[2]!.shots[0] as { text?: string }).text = "Giao hàng trong 2 giờ";
    // What an interrupted attempt leaves behind: a current version carrying the key, and nothing else.
    const orphan = await repos.projects.createVersion(ctx, {
      projectId: created.project.id,
      ir,
      source: "patch",
      parentVersionId: base!.id,
      patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }] },
      createdBy: { type: "user", id: "usr_1" },
      advanceFrom: base!.id,
      idempotencyKey: "fb-orphan",
      feedbackId: "rev_00000000000000000000000000",
    });
    const out = await service.submitFeedback(ctx, {
      projectId: created.project.id,
      shotId: "feature-1",
      comment: "Nhấn mạnh tốc độ giao hàng",
      baseVersionId: base!.id,
      idempotencyKey: "fb-orphan",
      patch: { ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }] },
    });
    expect(out).toMatchObject({ versionId: orphan.id, baseVersionId: base!.id, replayed: false });
    expect(out.job?.status).toBe("queued");
    expect((await repos.projects.listVersions(ctx, created.project.id)).items).toHaveLength(2);
    const comments = await repos.reviews.list(ctx, { projectId: created.project.id });
    expect(comments.items.map((c) => c.id)).toEqual([out.feedbackId]);
  });

  it("parks expensive jobs for approval and blocks publish without approval", async () => {
    const service = studio();
    const ctx = await tenant("svc-approval");
    const created = await service.createVideoProject(ctx, {
      brief: { prompt: "Expensive" },
      budgetCents: 5000,
    });
    expect(created.job.status).toBe("waiting_approval");
    const reviewer: TenantContext = { ...ctx, actor: { type: "user", id: "usr_rev", role: "reviewer" } };
    await service.approve(reviewer, { approvalId: created.approval!.id, decision: "approved" });
    expect((await service.getJob(ctx, created.job.id)).status).toBe("queued");

    const publish = {
      action: "publish" as const,
      subjectType: "project" as const,
      subjectId: created.project.id,
    };
    await expect(service.ensureApproved(ctx, publish)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    const pending = await db.current.repos.approvals.findLatest(
      ctx,
      { type: "project", id: created.project.id },
      "publish",
    );
    const apiKey: TenantContext = {
      ...ctx,
      actor: { type: "apiKey", id: "key_1", scopes: ["approval:decide"] },
    };
    await expect(
      service.approve(apiKey, { approvalId: pending!.id, decision: "approved" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await service.approve(reviewer, { approvalId: pending!.id, decision: "approved" });
    await expect(service.ensureApproved(ctx, publish)).resolves.toMatchObject({ required: true });
    const audit = await db.current.repos.audit.list(ctx, { subjectId: created.project.id });
    expect(audit.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(["project.created", "approval.blocked", "approval.approved"]),
    );
  });
});
