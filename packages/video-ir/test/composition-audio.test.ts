import { describe, expect, it } from "vitest";
import {
  type AssetRef,
  applyPatch,
  IR_MAX_AUDIO_TRACKS,
  invalidatedNodes,
  nodeDigests,
  type VideoIR,
  validateVideoIR,
  videoIrNodes,
} from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

const ir = () => loadFixture("brand-intro-9x16.json") as VideoIR;
const digestsOf = (doc: VideoIR) => nodeDigests(videoIrNodes(doc));
const issues = (doc: VideoIR) => {
  const result = validateVideoIR(doc);
  return result.ok ? [] : result.issues.map((i) => `${i.code} ${i.path}`);
};

const glScene: AssetRef = {
  id: "steam-gl",
  kind: "code",
  storageKey: "assets/ast_steam/v3/steam.js",
  sha256: "2".repeat(64),
  mime: "text/javascript",
  assetVersionId: "astv_steam_3",
  provenance: { source: "upload" },
};

/** Replaces the second feature card with a composition shot driven by the GL scene. */
function withComposition(asset: AssetRef = glScene): VideoIR {
  const doc = ir();
  doc.assets.push(asset);
  const feature = doc.scenes[2]!;
  const { id, startMs, durationMs } = feature.shots[1]!;
  feature.shots[1] = {
    id,
    type: "composition",
    startMs,
    durationMs,
    assetId: asset.id,
    entry: "main",
    params: { density: 0.6, tint: "#ffffff", loop: true },
  };
  return doc;
}

describe("composition shots", () => {
  it("accept a pinned code asset", () => {
    expect(issues(withComposition())).toEqual([]);
  });

  it("reject a code asset without a pinned version", () => {
    const { assetVersionId: _, ...unpinned } = glScene;
    expect(issues(withComposition(unpinned))).toContain("unpinned_code /scenes/2/shots/1/assetId");
  });

  it("reject an asset that is not code", () => {
    expect(issues(withComposition({ ...glScene, kind: "image", mime: "image/png" }))).toContain(
      "wrong_asset_kind /scenes/2/shots/1/assetId",
    );
  });
});

describe("audio tracks", () => {
  const music = {
    id: "bed",
    kind: "music" as const,
    assetId: "bed-audio",
    startMs: 0,
    durationMs: 4000,
    volume: 0.8,
    gainDb: -6,
    fadeInMs: 500,
    fadeOutMs: 1000,
  };
  const withAudio = (track: NonNullable<VideoIR["audio"]>[number]) => {
    const doc = ir();
    doc.assets.push({
      id: "bed-audio",
      kind: "audio",
      storageKey: "assets/ast_bed/v1/bed.mp3",
      sha256: "3".repeat(64),
      mime: "audio/mpeg",
      provenance: { source: "upload" },
    });
    doc.audio = [track];
    return doc;
  };

  it("accept gain and fades within the clip", () => {
    expect(issues(withAudio(music))).toEqual([]);
  });

  it("reject fades longer than the clip", () => {
    expect(issues(withAudio({ ...music, fadeInMs: 3000, fadeOutMs: 2000 }))).toContain(
      "out_of_bounds /audio/0/fadeOutMs",
    );
  });

  it("carry up to IR_MAX_AUDIO_TRACKS tracks, the audio of a 60 s graphic", () => {
    const many = (n: number) => {
      const doc = withAudio(music);
      doc.audio = Array.from({ length: n }, (_, i) => ({
        ...music,
        id: `track-${i}`,
        durationMs: 1000,
        fadeInMs: 0,
        fadeOutMs: 0,
      }));
      return doc;
    };
    expect(issues(many(IR_MAX_AUDIO_TRACKS))).toEqual([]);
    expect(issues(many(IR_MAX_AUDIO_TRACKS + 1)).some((i) => i.startsWith("schema /audio"))).toBe(true);
  });

  it("reject gain outside the mixer range", () => {
    expect(
      issues(withAudio({ ...music, gainDb: 20 })).some((i) => i.startsWith("schema /audio/0/gainDb")),
    ).toBe(true);
  });
});

describe("VideoIR dependency graph", () => {
  it("patching one shot invalidates that shot, its scene and the document only", () => {
    const before = ir();
    const after = applyPatch(before, {
      ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }],
    });
    expect(invalidatedNodes(digestsOf(before), digestsOf(after)).sort()).toEqual([
      "document",
      "scene:feature",
      "shot:feature-1",
    ]);
  });

  it("a new code asset version reaches the composition shot that pins it", () => {
    const before = withComposition();
    const after = withComposition({ ...glScene, sha256: "4".repeat(64), assetVersionId: "astv_steam_4" });
    expect(invalidatedNodes(digestsOf(before), digestsOf(after)).sort()).toEqual([
      "asset:steam-gl",
      "document",
      "scene:feature",
      "shot:feature-2",
    ]);
  });
});
