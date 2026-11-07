import { readFileSync } from "node:fs";
import { type AssetKind, inferAssetRole, type TenantContext } from "@studix/core";
import { sql } from "drizzle-orm";
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

describe("asset organization", () => {
  it("infers role and folder, filters by role, folder and tag, and updates per tenant", async () => {
    const { assets } = db.current.repos;
    const ctx = await tenant("asset-org");
    const other = await tenant("asset-org-other");
    const sfx = await assets.create(ctx, { kind: "audio", name: "whoosh.wav", createdBy });
    const shot = await assets.create(ctx, {
      kind: "image",
      name: "frame.png",
      role: "keyframe",
      path: "Ep03/sc01/s05",
      tags: ["Hero", "hero"],
      createdBy,
    });
    await assets.create(other, { kind: "audio", name: "whoosh.wav", createdBy });

    expect(sfx).toMatchObject({ role: "sfx", path: "sfx", tags: [] });
    expect(shot).toMatchObject({ role: "keyframe", path: "ep03/sc01/s05", tags: ["hero"] });

    expect((await assets.list(ctx, { role: "sfx" })).items.map((a) => a.id)).toEqual([sfx.id]);
    expect((await assets.list(ctx, { pathPrefix: "ep03" })).items.map((a) => a.id)).toEqual([shot.id]);
    expect((await assets.list(ctx, { pathPrefix: "ep03/sc01/s05" })).items).toHaveLength(1);
    // `_` is a LIKE wildcard and must not match other characters.
    expect((await assets.list(ctx, { pathPrefix: "ep0_" })).items).toHaveLength(0);
    expect((await assets.list(ctx, { pathPrefix: "ep0" })).items).toHaveLength(0);
    expect((await assets.list(ctx, { tag: "Hero" })).items.map((a) => a.id)).toEqual([shot.id]);
    expect((await assets.list(ctx, {})).items).toHaveLength(2);

    const moved = await assets.update(ctx, sfx.id, { role: "vfx", path: "ep03/sc01", tags: ["Boom"] });
    expect(moved).toMatchObject({ role: "vfx", path: "ep03/sc01", tags: ["boom"] });
    await expect(assets.update(other, sfx.id, { role: "prop" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assets.update(ctx, sfx.id, { path: "a/../b" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("backfills roles from kind and file name and puts them in a role folder", async () => {
    const { assets } = db.current.repos;
    const ctx = await tenant("asset-backfill");
    const rows = [
      ["audio", "ep1-whoosh.wav", "sfx"],
      ["audio", "main-theme.mp3", "bgm"],
      ["audio", "narration-line1.mp3", "voice"],
      ["audio", "mix.mp3", "other"],
      ["image", "hero-character-sheet.png", "character"],
      ["image", "city-background.png", "background"],
      ["render", "final.mp4", "render"],
      ["audio", "impact-music.wav", "sfx"],
      ["image", "bg01.png", "background"],
      ["audio", "vo2.wav", "voice"],
      ["image", "chess-board.png", "other"],
      ["audio", "bass-line.wav", "other"],
      ["audio", "scoreboard-beep.wav", "other"],
      ["image", "text-overlay.png", "other"],
    ] as const;
    const created = [];
    for (const [kind, name] of rows) {
      // Rows from before the migration all carry the defaults.
      created.push(await assets.create(ctx, { kind, name, role: "other", path: "", createdBy }));
    }
    const migration = readFileSync(
      new URL("../migrations/0034_asset_roles_paths_tags.sql", import.meta.url),
      "utf8",
    );
    const backfill = migration.slice(migration.indexOf("-- Backfill"));
    for (const statement of backfill.split("--> statement-breakpoint")) {
      await db.current.db.execute(sql.raw(statement));
    }
    for (const [i, [, , role]] of rows.entries()) {
      const row = await assets.get(ctx, (created[i] as { id: string }).id);
      expect(row?.role, rows[i]?.[1]).toBe(role);
      expect(inferAssetRole(rows[i]?.[0] as AssetKind, rows[i]?.[1] as string)).toBe(role);
      expect(row?.path).toBe(role === "other" ? "" : role);
    }
  });
});
