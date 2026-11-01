import type { AssetMediaKind } from "./asset-ref.ts";
import { CreativeBrief } from "./creative-brief.ts";
import {
  safeValidate,
  toPointer,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult,
} from "./validation-result.ts";
import { VideoIR } from "./video-ir.ts";

type Path = ReadonlyArray<string | number>;

/** Cross-field invariants that a schema alone cannot express. */
export function semanticIssues(ir: VideoIR): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: Path, code: ValidationIssueCode, message: string) =>
    issues.push({ path: toPointer(path), code, message });
  const total = ir.format.durationMs;

  const unique = (items: ReadonlyArray<{ id: string }>, base: Path) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.id)) add([...base, i, "id"], "duplicate_id", `duplicate id "${item.id}"`);
      seen.add(item.id);
    });
  };

  const assets = new Map(ir.assets.map((a) => [a.id, a]));
  const checkAsset = (path: Path, assetId: string | undefined, kinds: AssetMediaKind[]) => {
    if (assetId === undefined) return;
    const asset = assets.get(assetId);
    if (!asset) add(path, "unknown_reference", `unknown asset "${assetId}"`);
    else if (!kinds.includes(asset.kind))
      add(path, "wrong_asset_kind", `asset "${assetId}" is ${asset.kind}, expected ${kinds.join(" or ")}`);
  };

  unique(ir.assets, ["assets"]);
  unique(ir.scenes, ["scenes"]);
  checkAsset(["brand", "logoAssetId"], ir.brand?.logoAssetId, ["image"]);

  // Shot ids are unique across the whole document so patches and review comments can address them.
  const shotIds = new Set<string>();
  ir.scenes.forEach((scene, si) => {
    checkAsset(["scenes", si, "background", "assetId"], scene.background?.assetId, ["image", "video"]);
    if (scene.transitionOut && scene.transitionOut.durationMs > scene.durationMs) {
      add(
        ["scenes", si, "transitionOut", "durationMs"],
        "out_of_bounds",
        "transition is longer than the scene",
      );
    }
    scene.shots.forEach((shot, i) => {
      const path = ["scenes", si, "shots", i];
      if (shotIds.has(shot.id)) add([...path, "id"], "duplicate_id", `duplicate shot id "${shot.id}"`);
      shotIds.add(shot.id);
      if (shot.startMs + shot.durationMs > scene.durationMs) {
        add([...path, "durationMs"], "out_of_bounds", `shot "${shot.id}" ends after its scene`);
      }
      if (shot.type === "image") checkAsset([...path, "assetId"], shot.assetId, ["image"]);
      if (shot.type === "video") checkAsset([...path, "assetId"], shot.assetId, ["video"]);
      if (shot.type === "composition") {
        checkAsset([...path, "assetId"], shot.assetId, ["code"]);
        // A composition is code: it must be pinned to a library version so re-renders are reproducible.
        const code = assets.get(shot.assetId);
        if (code?.kind === "code" && code.assetVersionId === undefined)
          add([...path, "assetId"], "unpinned_code", `code asset "${shot.assetId}" has no assetVersionId`);
      }
      if (shot.type === "logo") {
        checkAsset([...path, "assetId"], shot.assetId, ["image"]);
        if (!shot.assetId && !shot.text && !ir.brand?.logoAssetId) {
          add([...path], "unknown_reference", "logo shot needs an assetId, text, or brand.logoAssetId");
        }
      }
    });
  });

  // Timeline: each scene once, contiguous from 0, ending exactly at format.durationMs.
  const scenes = new Map(ir.scenes.map((s) => [s.id, s]));
  const placed = new Set<string>();
  let cursor = 0;
  ir.timeline.entries.forEach((entry, i) => {
    const path = ["timeline", "entries", i];
    const scene = scenes.get(entry.sceneId);
    if (!scene) {
      add([...path, "sceneId"], "unknown_reference", `unknown scene "${entry.sceneId}"`);
      return;
    }
    if (placed.has(entry.sceneId))
      add([...path, "sceneId"], "timeline", `scene "${entry.sceneId}" is placed twice`);
    placed.add(entry.sceneId);
    if (entry.startMs !== cursor) {
      add(
        [...path, "startMs"],
        "timeline",
        `expected startMs ${cursor} (no gaps or overlaps), got ${entry.startMs}`,
      );
    }
    cursor = entry.startMs + scene.durationMs;
  });
  for (const scene of ir.scenes) {
    if (!placed.has(scene.id))
      add(["timeline", "entries"], "timeline", `scene "${scene.id}" is not on the timeline`);
  }
  if (cursor !== total) {
    add(
      ["format", "durationMs"],
      "timeline",
      `timeline ends at ${cursor}ms but format.durationMs is ${total}ms`,
    );
  }
  (ir.timeline.markers ?? []).forEach((marker, i) => {
    if (marker.atMs > total)
      add(["timeline", "markers", i, "atMs"], "out_of_bounds", "marker is after the end");
  });
  if (ir.timeline.markers) unique(ir.timeline.markers, ["timeline", "markers"]);

  (ir.audio ?? []).forEach((track, i) => {
    const path = ["audio", i];
    checkAsset([...path, "assetId"], track.assetId, ["audio"]);
    const end = track.startMs + (track.durationMs ?? 0);
    if (track.startMs >= total || end > total)
      add([...path], "out_of_bounds", `audio "${track.id}" exceeds the video`);
    const fades = (track.fadeInMs ?? 0) + (track.fadeOutMs ?? 0);
    if (track.durationMs !== undefined && fades > track.durationMs)
      add([...path, "fadeOutMs"], "out_of_bounds", `audio "${track.id}" fades are longer than the track`);
  });
  if (ir.audio) unique(ir.audio, ["audio"]);

  let lastEnd = 0;
  (ir.captions?.cues ?? []).forEach((cue, i) => {
    const path = ["captions", "cues", i];
    if (cue.endMs > total) add([...path, "endMs"], "out_of_bounds", "caption ends after the video");
    if (cue.startMs < lastEnd) add([...path, "startMs"], "timeline", "captions overlap or are out of order");
    lastEnd = cue.endMs;
  });

  return issues;
}

/** Full validation: schema first, then semantic invariants. Never throws. */
export function validateVideoIR(input: unknown): ValidationResult<VideoIR> {
  const parsed = safeValidate(VideoIR, input);
  if (!parsed.ok) return parsed;
  const issues = semanticIssues(parsed.value);
  return issues.length === 0 ? parsed : { ok: false, issues };
}

export function validateCreativeBrief(input: unknown): ValidationResult<CreativeBrief> {
  return safeValidate(CreativeBrief, input);
}
