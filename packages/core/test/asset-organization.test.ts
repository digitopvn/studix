import { createManualClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  inferAssetRole,
  isInAssetFolder,
  normalizeAssetPath,
  normalizeAssetTags,
  organizeNewAsset,
} from "../src/entities/asset-organization.ts";
import { parseMediaExecRequest } from "../src/studio/media-exec.ts";
import { createInMemoryAssetRepository, testTenant } from "../src/testing/index.ts";

describe("asset path and tags", () => {
  it("normalizes folders and rejects anything that could escape or sprawl", () => {
    expect(normalizeAssetPath(" /Ep03//SC01/s05/ ")).toBe("ep03/sc01/s05");
    expect(normalizeAssetPath(undefined)).toBe("");
    for (const bad of ["../x", "a/./b", "a b", "a/../b", "é", "a".repeat(201), "1/2/3/4/5/6/7/8/9"]) {
      expect(() => normalizeAssetPath(bad), bad).toThrow(/not valid/);
    }
    expect(normalizeAssetTags([" Hero ", "hero", "ep03"])).toEqual(["hero", "ep03"]);
    expect(() => normalizeAssetTags(Array.from({ length: 17 }, (_, i) => `t${i}`))).toThrow(/at most 16/);
  });

  it("matches a folder and its subfolders, never a sibling with the same prefix", () => {
    expect(isInAssetFolder("ep03/sc01", "ep03")).toBe(true);
    expect(isInAssetFolder("ep03", "ep03")).toBe(true);
    expect(isInAssetFolder("ep030", "ep03")).toBe(false);
    expect(isInAssetFolder("anything", "")).toBe(true);
  });
});

describe("asset role", () => {
  it("infers a role from the file name within what the media kind can be", () => {
    expect(inferAssetRole({ name: "whoosh_01.wav", kind: "audio" })).toBe("sfx");
    expect(inferAssetRole({ name: "sound_effects.wav", kind: "audio" })).toBe("sfx");
    expect(inferAssetRole({ name: "bgm-main.mp3", kind: "audio" })).toBe("bgm");
    expect(inferAssetRole({ name: "narration_vi.mp3", kind: "audio" })).toBe("voice");
    expect(inferAssetRole({ name: "bg_city.png", kind: "image" })).toBe("background");
    expect(inferAssetRole({ name: "characters.png", kind: "image" })).toBe("character");
    expect(inferAssetRole({ name: "refs.jpg", kind: "image" })).toBe("reference");
    expect(inferAssetRole({ name: "takeover.mp3", kind: "audio" })).toBe("other");
    // A hint for another media kind does not apply.
    expect(inferAssetRole({ name: "final_music_video.mp4", kind: "video" })).toBe("other");
    expect(inferAssetRole({ name: "Impact.ttf", kind: "font" })).toBe("other");
    expect(inferAssetRole({ name: "fx-rate-chart.png", kind: "image" })).toBe("other");
    // A render keeps its role whatever its name says.
    expect(inferAssetRole({ name: "sfx_test.mp4", kind: "render" })).toBe("render");
  });

  it("defaults the folder to the role and keeps what the caller named", () => {
    expect(organizeNewAsset({ name: "boom_sfx.wav", kind: "audio" })).toEqual({
      role: "sfx",
      path: "sfx",
      tags: [],
    });
    expect(
      organizeNewAsset({
        name: "a.png",
        kind: "image",
        role: "keyframe",
        path: "Ep03/Sc01/S05",
        tags: ["Hero"],
      }),
    ).toEqual({ role: "keyframe", path: "ep03/sc01/s05", tags: ["hero"] });
    expect(organizeNewAsset({ name: "x.bin", kind: "document" })).toMatchObject({ role: "other", path: "" });
  });
});

describe("in-memory asset repository", () => {
  const ctx = testTenant();

  it("filters by role, folder, tag and name", async () => {
    const assets = createInMemoryAssetRepository(createManualClock());
    const by = { type: "system", id: "t" } as const;
    await assets.create(ctx, {
      kind: "audio",
      name: "boom.wav",
      role: "sfx",
      path: "ep03/sc01",
      createdBy: by,
    });
    await assets.create(ctx, {
      kind: "image",
      name: "hero.png",
      role: "character",
      path: "ep030",
      tags: ["hero"],
      createdBy: by,
    });
    const names = async (q: Parameters<typeof assets.list>[1]) =>
      (await assets.list(ctx, q)).items.map((a) => a.name);
    expect(await names({ role: "sfx" })).toEqual(["boom.wav"]);
    expect(await names({ path: "ep03" })).toEqual(["boom.wav"]);
    expect(await names({ tag: "Hero" })).toEqual(["hero.png"]);
    expect(await names({ search: "BOOM" })).toEqual(["boom.wav"]);
    expect(await names({})).toHaveLength(2);
  });
});

describe("media exec outputs", () => {
  it("accepts role, path and tags and refuses a bad path before running", () => {
    const base = {
      tool: "ffmpeg",
      args: ["-i", "{in:a.mp4}", "{out:a.mp3}"],
      inputs: { "a.mp4": { assetId: "ast_1" } },
    };
    const parsed = parseMediaExecRequest({
      ...base,
      outputs: [{ name: "a.mp3", role: "bgm", path: "ep03/audio", tags: ["theme"] }],
    });
    expect(parsed.outputs[0]).toMatchObject({ role: "bgm", path: "ep03/audio" });
    expect(() => parseMediaExecRequest({ ...base, outputs: [{ name: "a.mp3", path: "../x" }] })).toThrow();
    expect(() => parseMediaExecRequest({ ...base, outputs: [{ name: "a.mp3", role: "music" }] })).toThrow();
  });
});
