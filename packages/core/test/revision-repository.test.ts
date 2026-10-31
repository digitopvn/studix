import { createManualClock } from "@studix/shared";
import { applyPatch, type VideoIR } from "@studix/video-ir";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import {
  createInMemoryRevisionRepository,
  createInMemoryStageCache,
  createInMemoryStudio,
  testTenant,
} from "../src/testing/index.ts";

const brief = { prompt: "Video giới thiệu thương hiệu cà phê Sương Mai, 15 giây, dọc", language: "vi" };

async function setup() {
  const { studio, repos } = createInMemoryStudio();
  const ctx = testTenant();
  const revisions = createInMemoryRevisionRepository(createManualClock(), repos.projects);
  const out = await studio.createVideoProject(ctx, { brief, spec: brandIntro });
  const projectId = out.project.id;
  const first = (await repos.projects.get(ctx, projectId))!.currentVersionId!;
  const v1 = (await repos.projects.getVersion(ctx, first))!;
  const patchVersion = async (parent: typeof v1, path: string, value: unknown) => {
    const patch = { ops: [{ op: "replace" as const, path, value }] };
    return repos.projects.createVersion(ctx, {
      projectId,
      ir: applyPatch(parent.ir as VideoIR, patch),
      source: "patch",
      parentVersionId: parent.id,
      patch,
      createdBy: parent.createdBy,
    });
  };
  return { ctx, revisions, v1, patchVersion };
}

describe("in-memory revision repository", () => {
  it("records one revision per scene and shot, and a patch adds revisions only for what it invalidated", async () => {
    const { ctx, revisions, v1, patchVersion } = await setup();
    const r1 = await revisions.recordVersion(ctx, v1.id);
    expect(r1.revisions).toHaveLength(4 + 6);
    expect(r1.revisions.every((r) => r.revision === 1 && r.versionId === v1.id)).toBe(true);
    expect(r1.invalidated).toHaveLength(10);

    const v2 = await patchVersion(v1, "/scenes/2/shots/0/text", "Giao hàng trong 2 giờ");
    const r2 = await revisions.recordVersion(ctx, v2.id);
    expect(r2.invalidated.sort()).toEqual(["scene:feature", "shot:feature-1"]);
    const reused = r2.revisions.filter((r) => r.versionId === v1.id);
    expect(reused).toHaveLength(8);
    const shot = r2.revisions.find((r) => r.nodeId === "feature-1")!;
    expect(shot).toMatchObject({ revision: 2, versionId: v2.id, content: { text: "Giao hàng trong 2 giờ" } });

    // Idempotent per version, and reverting the text points back at revision 1 instead of minting 3.
    expect(await revisions.recordVersion(ctx, v2.id)).toEqual(r2);
    const v3 = await patchVersion(
      v2,
      "/scenes/2/shots/0/text",
      ((v1.ir as VideoIR).scenes[2]!.shots[0] as { text: string }).text,
    );
    const r3 = await revisions.recordVersion(ctx, v3.id);
    expect(r3.revisions.find((r) => r.nodeId === "feature-1")).toMatchObject({ revision: 1 });
  });

  it("traces asset versions derived, directly or transitively, from an invalidated revision", async () => {
    const { ctx, revisions, v1 } = await setup();
    const { revisions: nodes } = await revisions.recordVersion(ctx, v1.id);
    const shot = nodes.find((r) => r.nodeId === "feature-1")!;
    const other = nodes.find((r) => r.nodeId === "hook-title")!;
    await revisions.addLineage(ctx, [
      { assetVersionId: "astv_clip", inputKind: "node_revision", inputId: shot.id, role: "shot" },
      { assetVersionId: "astv_upscaled", inputKind: "asset_version", inputId: "astv_clip", role: "source" },
      { assetVersionId: "astv_title", inputKind: "node_revision", inputId: other.id },
    ]);
    // Recording the same edge again is a no-op.
    await revisions.addLineage(ctx, [
      { assetVersionId: "astv_clip", inputKind: "node_revision", inputId: shot.id },
    ]);
    expect(await revisions.listLineage(ctx, "astv_clip")).toHaveLength(1);
    expect(await revisions.derivedAssetVersions(ctx, [{ kind: "node_revision", id: shot.id }])).toEqual([
      "astv_clip",
      "astv_upscaled",
    ]);
  });

  it("in-memory stage cache keeps the first output per tenant and key", async () => {
    const cache = createInMemoryStageCache(createManualClock());
    const ctx = testTenant();
    await cache.put(ctx, { stage: "compose", cacheKey: "k", output: { n: 1 } });
    const second = await cache.put(ctx, { stage: "compose", cacheKey: "k", output: { n: 2 } });
    expect(second.output).toEqual({ n: 1 });
    expect((await cache.get(ctx, "compose", "k"))?.output).toEqual({ n: 1 });
    expect(await cache.get(testTenant(), "compose", "k")).toBeUndefined();
  });

  it("is tenant-scoped and rejects unknown versions", async () => {
    const { ctx, revisions, v1 } = await setup();
    await revisions.recordVersion(ctx, v1.id);
    const stranger = testTenant({ organizationId: "org_other", workspaceId: "ws_other" });
    expect(await revisions.listVersionRevisions(stranger, v1.id)).toEqual([]);
    await expect(revisions.recordVersion(ctx, "pver_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
