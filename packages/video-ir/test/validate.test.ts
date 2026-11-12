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

  it("enforces the camera grammar: no repeated move on adjacent scenes, match cuts need motifs", () => {
    const ir = base();
    ir.scenes[0]!.camera = { move: "push-in" };
    ir.scenes[1]!.camera = { move: "push-in" };
    ir.scenes[0]!.transitionOut = { kind: "match-cut", durationMs: 0 };
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "camera", path: "/scenes/1/camera/move" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "camera", path: "/scenes/0/transitionOut/kind" }),
    );
    ir.scenes[1]!.camera = { move: "parallax", intensity: 1.5 };
    ir.scenes[0]!.motif = { shape: "circle", anchor: "top-right" };
    ir.scenes[1]!.motif = { shape: "circle", anchor: "bottom-left", size: "large" };
    ir.scenes[0]!.depth = { background: ["grid", "glow", "grain", "vignette"], foreground: ["corners"] };
    // Two static scenes in a row are fine: static is no move.
    ir.scenes[2]!.camera = { move: "static" };
    ir.scenes[3]!.camera = { move: "static" };
    expect(validateVideoIR(ir).ok).toBe(true);
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

  it("holds the audio of a 60 s graphic: a voice line per card plus a whoosh per cut", () => {
    const ir = base();
    ir.assets.push({
      id: "whoosh",
      kind: "audio",
      storageKey: "assets/a/whoosh.mp3",
      sha256: "a".repeat(64),
      mime: "audio/mpeg",
      provenance: { source: "upload" },
    });
    ir.audio = Array.from({ length: 25 }, (_, i) => ({
      id: `t-${i}`,
      kind: "sfx" as const,
      assetId: "whoosh",
      startMs: i * 100,
      durationMs: 100,
      volume: 0.3,
    }));
    expect(validateVideoIR(ir).ok).toBe(true);
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
