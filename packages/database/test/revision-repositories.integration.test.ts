import type { ProjectVersion, TenantContext } from "@studix/core";
import { applyPatch, type VideoIR } from "@studix/video-ir";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };
const createdBy = { type: "user" as const, id: "usr_1" };

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

async function projectWithVersion(ctx: TenantContext) {
  const { projects } = db.current.repos;
  const project = await projects.create(ctx, {
    title: "R",
    status: "draft",
    brief: { prompt: "r" },
    createdBy,
  });
  const v1 = await projects.createVersion(ctx, {
    projectId: project.id,
    ir: brandIntro as VideoIR,
    source: "client",
    createdBy,
  });
  const patch = async (parent: ProjectVersion, path: string, value: unknown) => {
    const p = { ops: [{ op: "replace" as const, path, value }] };
    return projects.createVersion(ctx, {
      projectId: project.id,
      ir: applyPatch(parent.ir, p),
      source: "patch",
      parentVersionId: parent.id,
      patch: p,
      createdBy,
    });
  };
  return { project, v1, patch };
}

describe("Postgres revision repository", () => {
  it("records scene and shot revisions; a patch mints revisions only for invalidated nodes", async () => {
    const { revisions } = db.current.repos;
    const ctx = await tenant("rev-record");
    const { v1, patch } = await projectWithVersion(ctx);

    const r1 = await revisions.recordVersion(ctx, v1.id);
    expect(r1.revisions).toHaveLength(10);
    expect(r1.revisions.map((r) => `${r.kind}:${r.nodeId}`).slice(0, 2)).toEqual([
      "scene:hook",
      "shot:hook-title",
    ]);

    const v2 = await patch(v1, "/scenes/2/shots/0/text", "Giao hàng trong 2 giờ");
    const [r2, again] = await Promise.all([
      revisions.recordVersion(ctx, v2.id),
      revisions.recordVersion(ctx, v2.id),
    ]);
    expect(again).toEqual(r2);
    expect(r2.invalidated.sort()).toEqual(["scene:feature", "shot:feature-1"]);
    expect(r2.revisions.filter((r) => r.versionId === v1.id)).toHaveLength(8);
    expect(r2.revisions.find((r) => r.nodeId === "feature-1")).toMatchObject({
      revision: 2,
      versionId: v2.id,
    });
    expect(await revisions.listVersionRevisions(ctx, v2.id)).toEqual(r2.revisions);

    const v3 = await patch(
      v2,
      "/scenes/2/shots/0/text",
      ((brandIntro as VideoIR).scenes[2]!.shots[0] as { text: string }).text,
    );
    const r3 = await revisions.recordVersion(ctx, v3.id);
    expect(r3.revisions.find((r) => r.nodeId === "feature-1")).toMatchObject({ revision: 1 });
  });

  it("traces lineage transitively and stays tenant-isolated", async () => {
    const { revisions } = db.current.repos;
    const ctx = await tenant("rev-lineage");
    const other = await tenant("rev-lineage-other");
    const { project, v1 } = await projectWithVersion(ctx);
    const { revisions: nodes } = await revisions.recordVersion(ctx, v1.id);
    const shot = nodes.find((r) => r.nodeId === "feature-1")!;
    const { assets } = db.current.repos;
    const asset = await assets.create(ctx, { projectId: project.id, kind: "video", name: "clip", createdBy });
    const version = (sha: string) =>
      assets.addVersion(ctx, {
        assetId: asset.id,
        storageKey: `k-${sha}`,
        sha256: sha.repeat(64),
        mime: "video/mp4",
        bytes: 1,
        provenance: { source: "generated" },
        createdBy,
      });
    const clip = (await version("a")).id;
    const upscaled = (await version("b")).id;

    await revisions.addLineage(ctx, [
      { assetVersionId: clip, inputKind: "node_revision", inputId: shot.id, role: "shot" },
      { assetVersionId: upscaled, inputKind: "asset_version", inputId: clip },
    ]);
    await revisions.addLineage(ctx, [{ assetVersionId: clip, inputKind: "node_revision", inputId: shot.id }]);
    expect(await revisions.listLineage(ctx, clip)).toHaveLength(1);
    expect(await revisions.derivedAssetVersions(ctx, [{ kind: "node_revision", id: shot.id }])).toEqual(
      [clip, upscaled].sort(),
    );
    expect(await revisions.derivedAssetVersions(other, [{ kind: "node_revision", id: shot.id }])).toEqual([]);
    expect(await revisions.getRevision(other, shot.id)).toBeUndefined();
    await expect(revisions.recordVersion(other, v1.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Postgres stage cache", () => {
  it("first write wins under concurrency and entries are tenant-scoped", async () => {
    const { stageCache } = db.current.repos;
    const ctx = await tenant("cache-a");
    const other = await tenant("cache-b");
    const writes = await Promise.all(
      [1, 2, 3, 4].map((n) => stageCache.put(ctx, { stage: "compose", cacheKey: "k1", output: { n } })),
    );
    expect(new Set(writes.map((w) => w.id)).size).toBe(1);
    const stored = await stageCache.get(ctx, "compose", "k1");
    expect(stored?.output).toEqual(writes[0]!.output);
    expect(await stageCache.get(other, "compose", "k1")).toBeUndefined();
    expect(await stageCache.get(ctx, "render", "k1")).toBeUndefined();
  });

  it("advanceFromVersionId lets exactly one of two concurrent versions on the same base become current", async () => {
    const { projects } = db.current.repos;
    const ctx = await tenant("rev-cas");
    const { project, v1 } = await projectWithVersion(ctx);
    await projects.update(ctx, project.id, { currentVersionId: v1.id });
    const attempt = (path: string, value: string) => {
      const p = { ops: [{ op: "replace" as const, path, value }] };
      return projects.createVersion(ctx, {
        projectId: project.id,
        ir: applyPatch(v1.ir, p),
        source: "patch",
        parentVersionId: v1.id,
        patch: p,
        createdBy,
        advanceFromVersionId: v1.id,
      });
    };
    const results = await Promise.allSettled([
      attempt("/scenes/2/shots/0/text", "A"),
      attempt("/scenes/2/shots/1/text", "B"),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<ProjectVersion> => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
    });
    expect((await projects.get(ctx, project.id))?.currentVersionId).toBe(won[0]?.value.id);
    expect((await projects.listVersions(ctx, project.id)).items).toHaveLength(2);
  });
});
