import { describe, expect, it } from "vitest";
import {
  canonicalReferences,
  type FilmProductionInput,
  type FilmProductionPhase,
  isContinuityBreak,
  type Storyboard,
  validateFilmProduction,
} from "../src/index.ts";
import { loadFixture } from "./load-fixture.ts";

const HASH = "3".repeat(64);

function storyboard(): Storyboard {
  const sb = loadFixture("storyboard/two-scenes.json") as Storyboard;
  sb.assets.push(
    {
      id: "lan-front-v2",
      kind: "image",
      storageKey: "assets/ast_lan2/v1/front.png",
      sha256: HASH,
      mime: "image/png",
      provenance: { source: "generated" },
    },
    {
      id: "greet-line",
      kind: "audio",
      storageKey: "assets/ast_line/v1/greet.wav",
      sha256: HASH,
      mime: "audio/wav",
      provenance: { source: "generated" },
    },
  );
  return sb;
}

function production(): FilmProductionInput {
  return {
    schemaVersion: 1,
    characters: [
      {
        characterId: "lan",
        identityVersion: 2,
        anchors: ["tóc ngắn ngang cằm", "tạp dề xanh"],
        palette: [{ name: "apron", hex: "#2f6f5e" }],
        handedness: "right",
        negatives: ["tóc dài"],
        voice: { voiceRef: "vi-female-1", language: "vi" },
        references: [
          { id: "lan-v1", assetId: "lan-sheet", view: "turnaround", status: "retired", version: 1 },
          {
            id: "lan-v2-front",
            assetId: "lan-front-v2",
            view: "front",
            status: "canonical",
            version: 2,
            promotedFrom: "lan-v1",
          },
        ],
      },
    ],
    shots: [
      {
        shotId: "greeting",
        renderClass: "CHARACTER_CRITICAL",
        visibleSpeakers: ["lan"],
        lipsync: "dedicated",
        state: { "position.lan": "left", "wardrobe.lan": "apron", direction: "static" },
        changes: [],
        conditioningRefs: ["lan-v2-front"],
      },
      {
        shotId: "pour-close",
        renderClass: "STANDARD",
        visibleSpeakers: [],
        lipsync: "none",
        continuityFrom: "greeting",
        boundary: "camera-transition",
        state: { "position.lan": "center", "wardrobe.lan": "apron", direction: "static" },
        changes: [],
      },
    ],
    dialogue: [
      {
        id: "greet-1",
        shotId: "greeting",
        characterId: "lan",
        text: "Chào anh, vẫn như mọi khi chứ?",
        status: "temp",
      },
    ],
  };
}

const codes = (p: FilmProductionInput, phase?: FilmProductionPhase, sb = storyboard()) => {
  const result = validateFilmProduction(p, sb, phase);
  return result.ok ? [] : result.issues.map((i) => `${i.code} ${i.path}`);
};

describe("FilmProduction", () => {
  it("accepts a consistent plan and design, and defaults the shot boundary", () => {
    const result = validateFilmProduction(production(), storyboard(), "design");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value.shots[0]!.boundary).toBe("intentional-cut");
  });

  it("rejects unknown characters, shots, assets and wrong asset kinds", () => {
    const p = production();
    p.characters[0]!.characterId = "ghost";
    p.characters[0]!.references[1]!.assetId = "greet-line";
    p.shots[1]!.shotId = "nowhere";
    p.dialogue[0]!.audioAssetId = "lan-sheet";
    const found = codes(p);
    expect(found).toContain("unknown_reference /characters/0/characterId");
    expect(found).toContain("wrong_asset_kind /characters/0/references/1/assetId");
    expect(found).toContain("unknown_reference /shots/1/shotId");
    expect(found).toContain("wrong_asset_kind /dialogue/0/audioAssetId");
    // `pour-close` shows Lan but lost its plan.
    expect(found).toContain("unknown_reference /scenes/1/shots/0/id");
  });

  it("only conditions on canonical references of the current identity", () => {
    const stale = production();
    stale.shots[0]!.conditioningRefs = ["lan-v1"];
    expect(codes(stale)).toEqual(["continuity /shots/0/conditioningRefs/0"]);

    const outdated = production();
    outdated.characters[0]!.identityVersion = 3;
    expect(codes(outdated)).toContain("continuity /characters/0/references/1/version");
    // With no canonical v3 reference, the design phase is not reached.
    expect(codes(outdated, "design")).toContain("not_ready /shots/0/shotId");
  });

  it("checks lipsync routing against visible speakers", () => {
    const silent = production();
    silent.shots[0]!.lipsync = "none";
    expect(codes(silent)).toEqual(["lipsync /shots/0/lipsync"]);

    const wasted = production();
    wasted.shots[1]!.lipsync = "native";
    expect(codes(wasted)).toEqual(["lipsync /shots/1/lipsync"]);

    const offscreen = production();
    offscreen.shots[0]!.visibleSpeakers = ["lan", "khach"];
    expect(codes(offscreen)).toContain("unknown_reference /shots/0/visibleSpeakers/1");
  });

  it("requires master audio with an alignment before lip-synced generation", () => {
    expect(codes(production(), "generation")).toEqual(["not_ready /shots/0/visibleSpeakers"]);
    const ready = production();
    ready.dialogue[0] = {
      ...ready.dialogue[0]!,
      status: "master",
      audioAssetId: "greet-line",
      alignment: {
        words: [
          { text: "Chào", startMs: 0, endMs: 300 },
          { text: "anh", startMs: 300, endMs: 520 },
        ],
      },
    };
    expect(codes(ready, "generation")).toEqual([]);

    ready.dialogue[0]!.alignment!.words[1]!.startMs = 200;
    expect(codes(ready, "generation")).toEqual(["timeline /dialogue/0/alignment/words/1"]);
  });

  it("flags undeclared continuity breaks and accepts declared ones", () => {
    const p = production();
    p.shots[1]!.state["wardrobe.lan"] = "no-apron";
    p.shots[1]!.state["position.lan"] = "right";
    expect(codes(p).sort()).toEqual([
      "continuity /shots/1/state/position.lan",
      "continuity /shots/1/state/wardrobe.lan",
    ]);

    p.shots[0]!.state["position.lan"] = "center";
    p.shots[1]!.changes = [{ field: "wardrobe.lan", reason: "cởi tạp dề sau giờ mở cửa" }];
    expect(codes(p)).toEqual([]);

    const self = production();
    self.shots[1]!.continuityFrom = "pour-close";
    expect(codes(self)).toEqual(["cycle /shots/1/continuityFrom"]);
  });

  it("treats staging moves and starting to move as continuous", () => {
    expect(isContinuityBreak("position.lan", "left", "offscreen")).toBe(false);
    expect(isContinuityBreak("position.lan", "left", "right")).toBe(true);
    expect(isContinuityBreak("direction", "static", "left_to_right")).toBe(false);
    expect(isContinuityBreak("direction", "left_to_right", "right_to_left")).toBe(true);
    expect(isContinuityBreak("prop.cup", "full", "empty")).toBe(true);
  });

  it("lists the canonical references a prompt is conditioned on", () => {
    const result = validateFilmProduction(production(), storyboard());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(canonicalReferences(result.value, "lan").map((r) => r.id)).toEqual(["lan-v2-front"]);
    expect(canonicalReferences(result.value, "ghost")).toEqual([]);
  });
});
