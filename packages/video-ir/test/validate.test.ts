import { describe, expect, it } from "vitest";
import {
  buildSequentialTimeline,
  type VideoIR,
  validateCreativeBrief,
  validateVideoIR,
} from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

const base = () => structuredClone(loadFixture("brand-intro-9x16.json")) as VideoIR;

describe("validateVideoIR semantic checks", () => {
  it("rejects non-objects without throwing", () => {
    expect(validateVideoIR(null).ok).toBe(false);
    expect(validateVideoIR("ir").ok).toBe(false);
  });

  it("detects duplicate scene and shot ids", () => {
    const ir = base();
    ir.scenes[1]!.shots[1]!.id = "intro-logo";
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.code)).toContain("duplicate_id");
  });

  it("detects scenes missing from the timeline and wrong total duration", () => {
    const ir = base();
    ir.timeline.entries.pop();
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "timeline", path: "/timeline/entries" }),
    );
    expect(result.issues).toContainEqual(expect.objectContaining({ path: "/format/durationMs" }));
  });

  it("checks asset kinds for references", () => {
    const ir = base();
    ir.assets.push({
      id: "song",
      kind: "audio",
      storageKey: "assets/a/song.mp3",
      sha256: "a".repeat(64),
      mime: "audio/mpeg",
      provenance: { source: "upload" },
    });
    ir.scenes[0]!.background = { assetId: "song" };
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues[0]).toMatchObject({
        code: "wrong_asset_kind",
        path: "/scenes/0/background/assetId",
      });
  });

  it("checks captions order and audio bounds", () => {
    const ir = base();
    ir.captions!.cues[1]!.startMs = 2000;
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues[0]).toMatchObject({ code: "timeline", path: "/captions/cues/1/startMs" });
  });

  it("rejects asset refs without a location and unsafe storage keys", () => {
    const ir = base();
    ir.assets.push({
      id: "x",
      kind: "image",
      sha256: "b".repeat(64),
      mime: "image/png",
      provenance: { source: "upload" },
    });
    expect(validateVideoIR(ir).ok).toBe(false);
    ir.assets[0]!.storageKey = "../other-tenant/x.png";
    expect(validateVideoIR(ir).ok).toBe(false);
  });

  it("builds sequential timelines", () => {
    expect(
      buildSequentialTimeline([
        { id: "a", durationMs: 100 },
        { id: "b", durationMs: 50 },
      ]),
    ).toEqual({
      entries: [
        { sceneId: "a", startMs: 0 },
        { sceneId: "b", startMs: 100 },
      ],
    });
  });
});

describe("validateCreativeBrief", () => {
  it("accepts a minimal Vietnamese brief and trims the prompt", () => {
    const result = validateCreativeBrief({
      prompt: "  Video giới thiệu thương hiệu cà phê  ",
      language: "vi",
    });
    expect(result).toEqual({
      ok: true,
      value: { prompt: "Video giới thiệu thương hiệu cà phê", language: "vi" },
    });
  });

  it("returns pointer paths for bad fields", () => {
    const result = validateCreativeBrief({ prompt: "", aspectRatio: "4:3" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.path).sort()).toEqual(["/aspectRatio", "/prompt"]);
  });
});
