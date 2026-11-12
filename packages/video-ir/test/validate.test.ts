import { describe, expect, it } from "vitest";
import {
  briefForAgent,
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

  it("enforces the camera rule in timeline order: no repeated move, match cuts carry a motif", () => {
    const ir = base();
    ir.scenes[0]!.camera = "push-in";
    ir.scenes[1]!.camera = "push-in";
    ir.scenes[0]!.transitionOut = { kind: "match-cut", durationMs: 0 };
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "camera", path: "/scenes/1/camera" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "camera", path: "/scenes/0/transitionOut/kind" }),
    );
    ir.scenes[1]!.camera = "parallax";
    ir.scenes[0]!.motif = { shape: "circle" };
    ir.scenes[1]!.motif = { shape: "circle" };
    // `static` is no move, so two still scenes may follow each other.
    ir.scenes[2]!.camera = "static";
    ir.scenes[3]!.camera = "static";
    expect(validateVideoIR(ir).ok).toBe(true);
  });

  it("walks the timeline, not the scenes array, for camera neighbours", () => {
    const ir = base();
    const [a, b, c] = ir.scenes as [
      VideoIR["scenes"][number],
      VideoIR["scenes"][number],
      VideoIR["scenes"][number],
    ];
    // Timeline a, c, b, ...: a and b sit side by side in the array but not on screen.
    ir.timeline = buildSequentialTimeline([a, c, b, ...ir.scenes.slice(3)]);
    a.camera = "push-in";
    b.camera = "push-in";
    expect(validateVideoIR(ir).ok).toBe(true);
    c.camera = "push-in";
    const result = validateVideoIR(ir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.filter((i) => i.code === "camera").map((i) => i.path)).toEqual([
      "/scenes/2/camera",
      "/scenes/1/camera",
    ]);
  });

  it("checks match-cut motifs by shape and ignores a match cut out of the last scene", () => {
    const ir = base();
    const last = ir.scenes.find((s) => s.id === ir.timeline.entries.at(-1)!.sceneId)!;
    last.transitionOut = { kind: "match-cut", durationMs: 0 };
    expect(validateVideoIR(ir).ok).toBe(true);
    const [a, b] = ir.scenes as [VideoIR["scenes"][number], VideoIR["scenes"][number]];
    a.transitionOut = { kind: "match-cut", durationMs: 0 };
    b.motif = { shape: "circle" };
    expect(validateVideoIR(ir).ok).toBe(false);
    a.motif = { shape: "square" };
    expect(validateVideoIR(ir).ok).toBe(false);
    a.motif = { shape: "circle", color: "accent" };
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

describe("briefForAgent", () => {
  it("leaves an uploaded logo out and keeps a logo URL", () => {
    const data = { prompt: "Logo", brandLogo: "data:image/png;base64,AAAA" };
    expect(briefForAgent(data)).toEqual({ prompt: "Logo" });
    const url = { prompt: "Logo", brandLogo: "https://acme.example/logo.png" };
    expect(briefForAgent(url)).toBe(url);
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

  it("takes a brand URL, logo and colours, and refuses a logo that is no https or image data URL", () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const ok = validateCreativeBrief({
      prompt: "x",
      brandUrl: "https://example.com",
      brandLogo: logo,
      brandColors: ["#123456"],
    });
    expect(ok).toMatchObject({ ok: true, value: { brandLogo: logo, brandColors: ["#123456"] } });
    for (const brandLogo of [
      "http://example.com/logo.png",
      "data:text/html;base64,PGh0bWw+",
      "data:image/png;base64,not base64!",
      // Over the 200,000-character cap that keeps a brief inside the 256 KB REST body.
      `data:image/png;base64,${"A".repeat(200_000)}`,
    ]) {
      const bad = validateCreativeBrief({ prompt: "x", brandLogo });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.issues.map((i) => i.path)).toEqual(["/brandLogo"]);
    }
    expect(validateCreativeBrief({ prompt: "x", brandUrl: "http://example.com" }).ok).toBe(false);
  });
});
