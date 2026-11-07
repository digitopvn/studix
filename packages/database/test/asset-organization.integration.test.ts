import type { TenantContext } from "@studix/core";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };
const createdBy = { type: "system" as const, id: "t" };

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

describe("asset roles, folders and tags", () => {
  it("stores role, path and tags, infers what is missing and filters the list", async () => {
    const { assets } = db.current.repos;
    const ctx = await tenant("asset-org");
    await assets.create(ctx, { kind: "audio", name: "boom.wav", role: "sfx", path: "Ep03/Sc01", createdBy });
    await assets.create(ctx, {
      kind: "image",
      name: "hero.png",
      role: "character",
      path: "ep030",
      tags: ["Hero", "lead"],
      createdBy,
    });
    const inferred = await assets.create(ctx, {
      kind: "audio",
      name: "bgm_main.mp3",
      mime: "audio/mpeg",
      createdBy,
    });
    expect(inferred).toMatchObject({ role: "bgm", path: "bgm", tags: [] });

    const names = async (q: Parameters<typeof assets.list>[1]) =>
      (await assets.list(ctx, q)).items.map((a) => a.name).sort();
    expect(await names({ role: "sfx" })).toEqual(["boom.wav"]);
    expect(await names({ path: "ep03" })).toEqual(["boom.wav"]);
    expect(await names({ path: "ep03/sc01" })).toEqual(["boom.wav"]);
    expect(await names({ path: "ep030" })).toEqual(["hero.png"]);
    expect(await names({ tag: "hero" })).toEqual(["hero.png"]);
    expect(await names({ search: "HERO" })).toEqual(["hero.png"]);
    expect(await names({ search: "100%_" })).toEqual([]);
    expect(await names({})).toHaveLength(3);
  });

  it("keeps folders and tags inside the workspace", async () => {
    const { assets } = db.current.repos;
    const a = await tenant("asset-iso-a");
    const b = await tenant("asset-iso-b");
    await assets.create(a, { kind: "image", name: "a.png", path: "shared", tags: ["x"], createdBy });
    expect((await assets.list(b, { path: "shared" })).items).toEqual([]);
    expect((await assets.list(b, { tag: "x" })).items).toEqual([]);
  });

  it("rejects a malformed path", async () => {
    const ctx = await tenant("asset-bad-path");
    await expect(
      db.current.repos.assets.create(ctx, { kind: "image", name: "a.png", path: "../x", createdBy }),
    ).rejects.toThrow(/not valid/);
  });
});
