import type { TenantContext } from "@studix/core";
import { createAssetService } from "@studix/core";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const createdBy = { type: "user" as const, id: "usr_owner" };

async function provision(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: slug, slug },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_owner", role: "owner" },
  };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("asset repository and service on Postgres", () => {
  it("filters, renames, trashes and restores inside one workspace", async () => {
    const { assets } = db.current.repos;
    const a = await provision("asset-a");
    const b = await provision("asset-b");
    const logo = await assets.create(a, { kind: "image", name: "Logo_100%", createdBy });
    await assets.create(a, { kind: "audio", name: "theme", createdBy });
    await assets.create(b, { kind: "image", name: "Logo_100%", createdBy });

    expect((await assets.list(a, { q: "logo" })).items.map((x) => x.id)).toEqual([logo.id]);
    // LIKE wildcards in the search text are literal.
    expect((await assets.list(a, { q: "%" })).items.map((x) => x.id)).toEqual([logo.id]);
    expect((await assets.list(a, { q: "_" })).items.map((x) => x.id)).toEqual([logo.id]);
    expect((await assets.list(a, { q: "o_o" })).items).toEqual([]);
    expect((await assets.list(a)).items).toHaveLength(2);

    const renamed = await assets.update(a, logo.id, { name: "hero" });
    expect(renamed.name).toBe("hero");
    expect(await assets.update(a, logo.id, { projectId: null })).toMatchObject({ projectId: undefined });

    const trashed = await assets.setDeleted(a, logo.id, true);
    expect(trashed.deletedAt).toBeInstanceOf(Date);
    const again = await assets.setDeleted(a, logo.id, true);
    expect(again.deletedAt?.getTime()).toBe(trashed.deletedAt?.getTime());
    expect((await assets.list(a)).items.map((x) => x.name)).toEqual(["theme"]);
    expect((await assets.list(a, { state: "deleted" })).items.map((x) => x.id)).toEqual([logo.id]);
    expect((await assets.list(a, { state: "all" })).items).toHaveLength(2);
    expect((await assets.setDeleted(a, logo.id, false)).deletedAt).toBeUndefined();
    expect((await assets.setDeleted(a, logo.id, false)).deletedAt).toBeUndefined();

    await expect(assets.update(b, logo.id, { name: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assets.setDeleted(b, logo.id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await assets.get(a, logo.id))?.name).toBe("hero");
  });

  it("runs the asset service end to end, lineage included", async () => {
    const { repos } = db.current;
    const ctx = await provision("asset-svc");
    const stored = new Map<string, Uint8Array>();
    const service = createAssetService({
      assets: repos.assets,
      projects: repos.projects,
      audit: repos.audit,
      revisions: repos.revisions,
      storage: {
        async put(_c, key, body, o) {
          stored.set(key, body as Uint8Array);
          return {
            key,
            bytes: (body as Uint8Array).byteLength,
            sha256: o.sha256 ?? "",
            contentType: o.contentType,
          };
        },
        async signedUrl(_c, key) {
          return `https://files.test/${key}`;
        },
      },
    });
    const src = await service.upload(ctx, { name: "src.png", base64: b64("src") });
    const out = await service.upload(ctx, {
      name: "out.png",
      base64: b64("out"),
      derivedFrom: [src.versionId],
    });
    const v2 = await service.upload(ctx, { assetId: src.asset.id, base64: b64("src-2") });
    expect(v2.version).toBe(2);
    const details = await service.get(ctx, { assetId: src.asset.id });
    expect(details.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(details.lineage.derivatives).toEqual([
      { assetId: out.asset.id, versionId: out.versionId, version: 1 },
    ]);
    expect((await service.get(ctx, { assetId: out.asset.id })).lineage.derivedFrom[0]).toMatchObject({
      assetId: src.asset.id,
      name: "src.png",
    });
    const audit = await repos.audit.list(ctx, { subjectId: src.asset.id });
    expect(audit.items.map((e) => e.action).sort()).toEqual(["asset.uploaded", "asset.version_added"]);

    const other = await provision("asset-svc-other");
    expect((await service.list(other)).items).toEqual([]);
    await expect(service.get(other, { assetId: src.asset.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
