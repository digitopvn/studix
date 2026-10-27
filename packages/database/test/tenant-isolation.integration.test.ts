import { createHash } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { describe, expect, it } from "vitest";
import { insertTestUser, withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const createdBy = { type: "user" as const, id: "usr_owner" };

async function provision(slug: string, orgId?: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: orgId ? { id: orgId } : { name: slug, slug },
    workspace: { name: slug, slug },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_owner", role: "owner" },
  };
}

async function seed(ctx: TenantContext) {
  const r = db.current.repos;
  const project = await r.projects.create(ctx, {
    title: "A",
    status: "draft",
    brief: { prompt: "a" },
    createdBy,
  });
  const job = (
    await r.queue.enqueue(ctx, {
      kind: "video.create",
      projectId: project.id,
      payload: {},
      idempotencyKey: "k",
      createdBy,
    })
  ).job;
  const asset = await r.assets.create(ctx, { projectId: project.id, kind: "image", name: "logo", createdBy });
  const approval = await r.approvals.create(ctx, {
    action: "publish",
    subject: { type: "project", id: project.id },
    reason: "publish",
    requestedBy: createdBy,
  });
  await r.audit.append(ctx, {
    actor: createdBy,
    action: "project.created",
    subjectType: "project",
    subjectId: project.id,
  });
  await r.activity.append(ctx, {
    name: "job.started",
    level: "info",
    jobId: job.id,
    attributes: { apiKey: "secret-value" },
  });
  return { project, job, asset, approval };
}

describe("tenant isolation (Postgres)", () => {
  it("workspace B cannot read, list, update or delete workspace A records", async () => {
    const a = await provision("iso-a");
    const sameOrg = await provision("iso-a2", a.organizationId);
    const otherOrg = await provision("iso-b");
    const forged: TenantContext = { ...otherOrg, workspaceId: a.workspaceId };
    const { project, job, asset, approval } = await seed(a);
    const r = db.current.repos;

    for (const b of [sameOrg, otherOrg, forged]) {
      expect(await r.projects.get(b, project.id)).toBeUndefined();
      expect((await r.projects.list(b)).items).toEqual([]);
      await expect(r.projects.update(b, project.id, { title: "pwned" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await r.projects.delete(b, project.id)).toBe(false);
      await expect(
        r.projects.createVersion(b, { projectId: project.id, ir: {} as never, source: "client", createdBy }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await r.jobs.get(b, job.id)).toBeUndefined();
      expect(await r.jobs.findByIdempotencyKey(b, "k")).toBeUndefined();
      await expect(r.queue.cancel(b, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(r.jobs.update(b, job.id, { status: "succeeded" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        r.jobs.upsertStage(b, { jobId: job.id, name: "x", attempt: 1, status: "running" }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await r.assets.get(b, asset.id)).toBeUndefined();
      await expect(
        r.assets.addVersion(b, {
          assetId: asset.id,
          storageKey: "k",
          sha256: "0".repeat(64),
          mime: "image/png",
          bytes: 1,
          provenance: { source: "upload" },
          createdBy,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await r.approvals.get(b, approval.id)).toBeUndefined();
      await expect(
        r.approvals.decide(b, approval.id, {
          status: "approved",
          decidedAt: new Date(),
          decidedBy: createdBy,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await r.audit.list(b)).items).toEqual([]);
      expect((await r.activity.list(b)).items).toEqual([]);
    }

    // A still sees everything untouched.
    expect((await r.projects.get(a, project.id))?.title).toBe("A");
    expect((await r.jobs.get(a, job.id))?.status).toBe("queued");
    expect((await r.approvals.get(a, approval.id))?.status).toBe("pending");
    const [activity] = (await r.activity.list(a)).items;
    expect(activity?.attributes).toEqual({ apiKey: "[redacted]" });
  });

  it("numbers project versions per project and keeps them immutable rows", async () => {
    const a = await provision("versions");
    const r = db.current.repos;
    const project = await r.projects.create(a, {
      title: "V",
      status: "draft",
      brief: { prompt: "v" },
      createdBy,
    });
    const ir = { schemaVersion: 1 } as never;
    const versions = await Promise.all(
      [1, 2, 3].map(() =>
        r.projects.createVersion(a, { projectId: project.id, ir, source: "planner", createdBy }),
      ),
    );
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3]);
    expect((await r.projects.listVersions(a, project.id)).items.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it("resolves API keys by hash only while active and scoped to their workspace", async () => {
    const a = await provision("keys-a");
    const b = await provision("keys-b");
    const r = db.current.repos;
    const hash = createHash("sha256").update("stx_test_example").digest("hex");
    const key = await r.apiKeys.create(a, {
      name: "ci",
      hash,
      prefix: "stx_test_exa",
      scopes: ["project:read"],
      createdBy,
    });
    const resolved = await r.directory.resolveApiKey(hash, new Date());
    expect(resolved).toMatchObject({
      apiKey: { id: key.id, scopes: ["project:read"] },
      workspace: { id: a.workspaceId },
    });
    expect(await r.apiKeys.get(b, key.id)).toBeUndefined();
    await expect(r.apiKeys.revoke(b, key.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await r.apiKeys.revoke(a, key.id);
    expect(await r.directory.resolveApiKey(hash, new Date())).toBeUndefined();
    await expect(
      r.apiKeys.create(b, { name: "dup", hash, prefix: "x", scopes: [], createdBy }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const expiring = createHash("sha256").update("stx_test_expiring").digest("hex");
    await r.apiKeys.create(a, {
      name: "tmp",
      hash: expiring,
      prefix: "p",
      scopes: [],
      createdBy,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await r.directory.resolveApiKey(expiring, new Date())).toBeDefined();
    expect(await r.directory.resolveApiKey(expiring, new Date(Date.now() + 120_000))).toBeUndefined();
  });

  it("lists memberships and keeps members scoped", async () => {
    const r = db.current.repos;
    await insertTestUser(db.current, { id: "usr_m1", email: "m1@example.com" });
    const { organization, workspace, owner } = await r.directory.provisionWorkspace({
      organization: { name: "Members", slug: "members" },
      workspace: { name: "Main", slug: "main" },
      ownerUserId: "usr_m1",
    });
    expect(owner?.role).toBe("owner");
    const ctx: TenantContext = {
      organizationId: organization.id,
      workspaceId: workspace.id,
      actor: { type: "system", id: "t" },
    };
    expect((await r.directory.listMemberships("usr_m1")).map((m) => m.workspace.id)).toEqual([workspace.id]);
    expect((await r.workspaces.upsertMember(ctx, { userId: "usr_m1", role: "viewer" })).role).toBe("viewer");
    const other = await provision("members-other");
    expect(await r.workspaces.getMember(other, "usr_m1")).toBeUndefined();
    expect(await r.workspaces.removeMember(other, "usr_m1")).toBe(false);
    expect(await r.workspaces.get(other)).toMatchObject({ workspace: { id: other.workspaceId } });
    await expect(
      r.directory.provisionWorkspace({
        organization: { id: organization.id },
        workspace: { name: "dup", slug: "main" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
