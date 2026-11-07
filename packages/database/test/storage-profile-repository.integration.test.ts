import type { TenantContext } from "@studix/core";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };
const createdBy = { type: "user" as const, id: "usr_1" };
const by = { type: "user", id: "usr_op" } as const;
const sealed = {
  accessKeyCiphertext: "v1.k.a",
  secretCiphertext: "v1.k.s",
  accessKeyHint: "…aaaa",
  secretHint: "…ssss",
};
const fields = (name: string) => ({
  name,
  providerType: "cloudflare-r2" as const,
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "media",
  region: "auto",
  forcePathStyle: false,
  keyPrefix: "",
});

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

async function addVersion(ctx: TenantContext, storageKey: string) {
  const { assets } = db.current.repos;
  const asset = await assets.create(ctx, { kind: "image", name: storageKey, createdBy });
  return assets.addVersion(ctx, {
    assetId: asset.id,
    storageKey,
    sha256: "a".repeat(64),
    mime: "image/png",
    bytes: 1,
    provenance: { source: "upload" },
    createdBy,
  });
}

describe("storage profile repository", () => {
  it("records env until a profile is active, then the active profile, per tenant", async () => {
    const { storageProfiles } = db.current.repos;
    const ctx = await tenant("stp-locate");
    const other = await tenant("stp-locate-other");
    await addVersion(ctx, "assets/old.png");
    expect(await storageProfiles.locate(ctx, "assets/old.png")).toBe("env");

    await storageProfiles.create({ id: "stp_one000", ...fields("One"), ...sealed }, by);
    await storageProfiles.activate("stp_one000", by);
    await addVersion(ctx, "assets/new.png");
    expect(await storageProfiles.locate(ctx, "assets/new.png")).toBe("stp_one000");
    expect(await storageProfiles.locate(ctx, "assets/old.png")).toBe("env");
    // Another tenant's key with the same name is not found through this tenant.
    expect(await storageProfiles.locate(other, "assets/new.png")).toBeUndefined();
    expect(await storageProfiles.countReferences("stp_one000")).toBe(1);

    await storageProfiles.activate(undefined, by);
    expect((await storageProfiles.list()).every((p) => !p.active)).toBe(true);
  });

  it("keeps exactly one active profile and deletes only inactive ones", async () => {
    const { storageProfiles } = db.current.repos;
    await storageProfiles.create({ id: "stp_two000", ...fields("Two"), ...sealed }, by);
    await storageProfiles.create({ id: "stp_three0", ...fields("Three"), ...sealed }, by);
    await storageProfiles.activate("stp_two000", by);
    await storageProfiles.activate("stp_three0", by);
    expect((await storageProfiles.list()).filter((p) => p.active).map((p) => p.id)).toEqual(["stp_three0"]);
    expect(await storageProfiles.delete("stp_three0")).toBe(false);
    expect(await storageProfiles.delete("stp_two000")).toBe(true);

    const updated = await storageProfiles.update(
      "stp_three0",
      { ...fields("Three b"), bucket: "media-2" },
      by,
    );
    expect(updated).toMatchObject({ version: 2, bucket: "media-2", accessKeyHint: "…aaaa" });
    expect(updated?.lastTest).toBeUndefined();
    await storageProfiles.activate(undefined, by);
  });
});

describe("workspace storage profiles", () => {
  it("records the workspace's own active profile, else the platform's, one active per scope", async () => {
    const { storageProfiles } = db.current.repos;
    const ctx = await tenant("stp-ws-own");
    const other = await tenant("stp-ws-other");
    await storageProfiles.create({ id: "stp_plat01", ...fields("Platform"), ...sealed }, by);
    await storageProfiles.create(
      { id: "stp_wsown1", workspaceId: ctx.workspaceId, ...fields("Own"), ...sealed },
      by,
    );
    await storageProfiles.activate("stp_plat01", by);
    await storageProfiles.activate("stp_wsown1", by, ctx.workspaceId);
    // Activating in one scope leaves the other scope's active profile alone.
    expect(
      (await storageProfiles.list())
        .filter((p) => p.active)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["stp_plat01", "stp_wsown1"]);
    // A platform activation cannot reach a workspace row.
    await storageProfiles.activate("stp_wsown1", by);
    expect((await storageProfiles.get("stp_plat01"))?.active).toBe(false);
    await storageProfiles.activate("stp_plat01", by);

    await addVersion(ctx, "assets/ws.png");
    await addVersion(other, "assets/ws.png");
    expect(await storageProfiles.locate(ctx, "assets/ws.png")).toBe("stp_wsown1");
    expect(await storageProfiles.locate(other, "assets/ws.png")).toBe("stp_plat01");
    expect((await storageProfiles.listScope(ctx.workspaceId)).map((p) => p.id)).toEqual(["stp_wsown1"]);
    expect((await storageProfiles.listScope(undefined)).map((p) => p.id)).toContain("stp_plat01");

    await storageProfiles.activate(undefined, by, ctx.workspaceId);
    await storageProfiles.activate(undefined, by);
  });
});
