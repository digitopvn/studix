import { createManualClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  defaultAssetPath,
  inferAssetRole,
  normalizeAssetPath,
  normalizeAssetTags,
} from "../src/entities/asset.ts";
import { createInMemoryAssetRepository, testTenant } from "../src/testing/index.ts";

describe("asset role inference", () => {
  it.each([
    ["audio", "whoosh-impact.wav", "sfx"],
    ["audio", "ep03_bgm_theme.mp3", "bgm"],
    ["audio", "narration-line2.mp3", "voice"],
    ["audio", "final-mix.mp3", "other"],
    ["image", "character-lead-sheet.png", "character"],
    ["image", "storyboard-03.png", "storyboard"],
    ["image", "bg_city_night.png", "background"],
    ["video", "explosion-overlay.mp4", "vfx"],
    ["image", "theme-song-cover.png", "other"],
    ["render", "anything.mp4", "render"],
    ["document", "notes.txt", "other"],
    ["audio", "impact-music.wav", "sfx"],
    ["audio", "theme-whoosh.wav", "sfx"],
    ["image", "bg01.png", "background"],
    ["audio", "vo2.wav", "voice"],
    ["image", "chess-board.png", "other"],
    ["audio", "bass-line.wav", "other"],
    ["audio", "invoice-call.mp3", "other"],
    ["audio", "scoreboard-beep.wav", "other"],
    ["image", "text-overlay.png", "other"],
  ] as const)("%s %s -> %s", (kind, name, role) => {
    expect(inferAssetRole(kind, name)).toBe(role);
  });

  it("folders default to the role", () => {
    expect(defaultAssetPath("sfx")).toBe("sfx");
    expect(defaultAssetPath("other")).toBe("");
  });
});

describe("asset path and tags", () => {
  it("normalizes folders", () => {
    expect(normalizeAssetPath(" /Ep03//SC01/s05/ ")).toBe("ep03/sc01/s05");
    expect(normalizeAssetPath("")).toBe("");
  });
  it("rejects traversal and odd characters", () => {
    expect(() => normalizeAssetPath("ep03/../x")).toThrow(/invalid asset path/);
    expect(() => normalizeAssetPath("a b")).toThrow(/invalid asset path/);
  });
  it("dedupes tags", () => {
    expect(normalizeAssetTags([" Hero ", "hero", "night"])).toEqual(["hero", "night"]);
  });
});

describe("in-memory asset repository organization", () => {
  const ctx = testTenant();
  const by = { type: "system", id: "test" } as const;

  it("infers role and folder, filters, and updates", async () => {
    const repo = createInMemoryAssetRepository(createManualClock());
    const sfx = await repo.create(ctx, { kind: "audio", name: "whoosh.wav", createdBy: by });
    const shot = await repo.create(ctx, {
      kind: "image",
      name: "frame.png",
      role: "keyframe",
      path: "ep03/sc01/s05",
      tags: ["hero"],
      createdBy: by,
    });
    expect(sfx).toMatchObject({ role: "sfx", path: "sfx", tags: [] });
    expect(shot).toMatchObject({ role: "keyframe", path: "ep03/sc01/s05" });

    expect((await repo.list(ctx, { role: "sfx" })).items.map((a) => a.id)).toEqual([sfx.id]);
    expect((await repo.list(ctx, { pathPrefix: "ep03" })).items.map((a) => a.id)).toEqual([shot.id]);
    expect((await repo.list(ctx, { pathPrefix: "ep0" })).items).toHaveLength(0);
    expect((await repo.list(ctx, { tag: "HERO" })).items.map((a) => a.id)).toEqual([shot.id]);

    const moved = await repo.update(ctx, sfx.id, { path: "ep03/sc01", role: "vfx" });
    expect(moved).toMatchObject({ role: "vfx", path: "ep03/sc01" });
    await expect(repo.update(ctx, "ast_missing", { role: "prop" })).rejects.toThrow(/not found/);
  });
});
