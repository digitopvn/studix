import { z } from "zod";
import { AssetRef } from "./asset-ref.ts";
import { type DependencyNode, nodeKey } from "./dependency-graph.ts";
import { applyJsonPatch, VideoIRPatch } from "./patch.ts";
import { AspectRatio, IrId, LanguageTag, Milliseconds, PositiveMilliseconds } from "./primitives.ts";
import { ShotType } from "./shot.ts";
import {
  safeValidate,
  toPointer,
  unwrapValidation,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult,
} from "./validation-result.ts";

/** Current Storyboard schema version; same migration policy as the VideoIR (see README.md). */
export const STORYBOARD_SCHEMA_VERSION = 1 as const;

export const StoryboardReviewStatus = z.enum(["draft", "in_review", "approved", "changes_requested"]);
export type StoryboardReviewStatus = z.infer<typeof StoryboardReviewStatus>;

/** Human review state of the storyboard, a scene or a shot. Not part of any content digest. */
export const StoryboardApproval = z.object({
  status: StoryboardReviewStatus,
  /** Actor id of the reviewer who set the status. */
  reviewer: z.string().min(1).max(120).optional(),
  decidedAt: z.iso.datetime({ offset: true }).optional(),
  note: z.string().max(1000).optional(),
});
export type StoryboardApproval = z.infer<typeof StoryboardApproval>;

/** Character bible entry shared by every shot that shows or voices the character (continuity anchor). */
export const CharacterRef = z.object({
  id: IrId,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Reference sheets / turnarounds from the storyboard `assets` list. */
  referenceAssetIds: z.array(IrId).max(16).optional(),
  /** Voice id of the speech provider used for this character's dialogue. */
  voice: z.string().min(1).max(200).optional(),
});
export type CharacterRef = z.infer<typeof CharacterRef>;

export const DialogueLine = z.object({
  characterId: IrId,
  text: z.string().min(1).max(1000),
  language: LanguageTag.optional(),
});
export type DialogueLine = z.infer<typeof DialogueLine>;

/** A story beat: the unit of narrative a shot covers (and the anchor for dialogue and beat-synced cuts). */
export const StoryboardBeat = z.object({
  id: IrId,
  summary: z.string().min(1).max(500),
  /** Planned position on the final timeline, when beat-synced to music. */
  atMs: Milliseconds.optional(),
  dialogue: z.array(DialogueLine).max(20).optional(),
});
export type StoryboardBeat = z.infer<typeof StoryboardBeat>;

export const StoryboardShot = z.object({
  id: IrId,
  /** VideoIR shot type this storyboard shot becomes (`composition` for GL / HTML scenes). */
  kind: ShotType,
  description: z.string().min(1).max(2000),
  durationMs: PositiveMilliseconds,
  camera: z.string().max(200).optional(),
  beatIds: z.array(IrId).max(20).optional(),
  characterIds: z.array(IrId).max(20).optional(),
  /** Assets the shot uses (start/end frames, plates, code assets) from the storyboard `assets` list. */
  assetIds: z.array(IrId).max(20).optional(),
  /** Shots this one must stay continuous with (e.g. starts on their last frame). */
  dependsOn: z.array(IrId).max(20).optional(),
  approval: StoryboardApproval,
});
export type StoryboardShot = z.infer<typeof StoryboardShot>;

export const StoryboardScene = z.object({
  id: IrId,
  title: z.string().min(1).max(200),
  summary: z.string().max(2000).optional(),
  shots: z.array(StoryboardShot).min(1).max(60),
  approval: StoryboardApproval,
});
export type StoryboardScene = z.infer<typeof StoryboardScene>;

/**
 * Pre-production plan shared by every pack: scenes of shots, the beats they cover, the characters and
 * assets they reference, and review state at every level. Planners turn an approved storyboard into a
 * VideoIR; patches produce a new immutable revision, like the IR.
 */
export const Storyboard = z.object({
  schemaVersion: z.literal(STORYBOARD_SCHEMA_VERSION),
  title: z.string().min(1).max(200),
  language: LanguageTag,
  aspectRatio: AspectRatio.optional(),
  characters: z.array(CharacterRef).max(50),
  assets: z.array(AssetRef).max(200),
  beats: z.array(StoryboardBeat).max(500),
  scenes: z.array(StoryboardScene).min(1).max(100),
  approval: StoryboardApproval,
});
export type Storyboard = z.infer<typeof Storyboard>;

type Path = ReadonlyArray<string | number>;

/** Cross-reference invariants: unique ids, resolvable references, acyclic shot continuity. */
export function storyboardIssues(sb: Storyboard): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: Path, code: ValidationIssueCode, message: string) =>
    issues.push({ path: toPointer(path), code, message });
  const ids = (items: ReadonlyArray<{ id: string }>, base: Path) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.id)) add([...base, i, "id"], "duplicate_id", `duplicate id "${item.id}"`);
      seen.add(item.id);
    });
    return seen;
  };
  const refs = (path: Path, values: readonly string[] | undefined, known: Set<string>, what: string) =>
    values?.forEach((v, i) => {
      if (!known.has(v)) add([...path, i], "unknown_reference", `unknown ${what} "${v}"`);
    });

  const assets = ids(sb.assets, ["assets"]);
  const characters = ids(sb.characters, ["characters"]);
  const beats = ids(sb.beats, ["beats"]);
  ids(sb.scenes, ["scenes"]);
  for (const [i, c] of sb.characters.entries()) {
    refs(["characters", i, "referenceAssetIds"], c.referenceAssetIds, assets, "asset");
  }
  for (const [i, b] of sb.beats.entries()) {
    for (const [j, line] of (b.dialogue ?? []).entries()) {
      if (!characters.has(line.characterId))
        add(
          ["beats", i, "dialogue", j, "characterId"],
          "unknown_reference",
          `unknown character "${line.characterId}"`,
        );
    }
  }

  const shots = new Set<string>();
  const dependsOn = new Map<string, readonly string[]>();
  for (const [si, scene] of sb.scenes.entries()) {
    for (const [i, shot] of scene.shots.entries()) {
      if (shots.has(shot.id))
        add(["scenes", si, "shots", i, "id"], "duplicate_id", `duplicate shot id "${shot.id}"`);
      shots.add(shot.id);
      dependsOn.set(shot.id, shot.dependsOn ?? []);
    }
  }
  for (const [si, scene] of sb.scenes.entries()) {
    for (const [i, shot] of scene.shots.entries()) {
      const path = ["scenes", si, "shots", i];
      refs([...path, "beatIds"], shot.beatIds, beats, "beat");
      refs([...path, "characterIds"], shot.characterIds, characters, "character");
      refs([...path, "assetIds"], shot.assetIds, assets, "asset");
      refs([...path, "dependsOn"], shot.dependsOn, shots, "shot");
    }
  }

  // Continuity must be a DAG, otherwise no shot of the cycle could be generated first.
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") return true;
    state.set(id, "visiting");
    const cyclic = (dependsOn.get(id) ?? []).some((d) => dependsOn.has(d) && visit(d));
    state.set(id, "done");
    return cyclic;
  };
  for (const id of dependsOn.keys()) {
    if (visit(id)) {
      add(["scenes"], "cycle", `shot continuity has a cycle through "${id}"`);
      break;
    }
  }
  return issues;
}

/** Schema then reference checks. Never throws. */
export function validateStoryboard(input: unknown): ValidationResult<Storyboard> {
  const parsed = safeValidate(Storyboard, input);
  if (!parsed.ok) return parsed;
  const issues = storyboardIssues(parsed.value);
  return issues.length === 0 ? parsed : { ok: false, issues };
}

/** Next immutable storyboard revision; throws VALIDATION (or CONFLICT on a failed `test` op). */
export function applyStoryboardPatch(sb: Storyboard, patch: VideoIRPatch): Storyboard {
  const valid = unwrapValidation(safeValidate(VideoIRPatch, patch), "Storyboard patch");
  return unwrapValidation(validateStoryboard(applyJsonPatch(sb, valid.ops)), "patched Storyboard");
}

/** Keys (`storyboard`, `scene:<id>`, `shot:<id>`) whose approval is not `approved`. */
export function pendingApprovals(sb: Storyboard): string[] {
  const pending: string[] = [];
  if (sb.approval.status !== "approved") pending.push("storyboard");
  for (const scene of sb.scenes) {
    if (scene.approval.status !== "approved") pending.push(nodeKey.scene(scene.id));
    for (const shot of scene.shots)
      if (shot.approval.status !== "approved") pending.push(nodeKey.shot(shot.id));
  }
  return pending;
}

/**
 * Dependency graph of a storyboard. A shot depends on its beats, characters, assets and continuity
 * predecessors; a character on its reference assets; a scene on its shots. Approval state is excluded, so
 * approving a shot never invalidates generated work.
 */
export function storyboardNodes(sb: Storyboard): DependencyNode[] {
  const nodes: DependencyNode[] = [
    { key: "aspect", content: sb.aspectRatio ?? null, dependsOn: [] },
    ...sb.assets.map((a) => ({ key: nodeKey.asset(a.id), content: a, dependsOn: [] })),
    ...sb.characters.map((c) => ({
      key: `character:${c.id}`,
      content: c,
      dependsOn: (c.referenceAssetIds ?? []).map(nodeKey.asset),
    })),
    ...sb.beats.map((b) => ({
      key: `beat:${b.id}`,
      content: b,
      dependsOn: (b.dialogue ?? []).map((d) => `character:${d.characterId}`),
    })),
  ];
  for (const scene of sb.scenes) {
    for (const { approval, ...shot } of scene.shots) {
      nodes.push({
        key: nodeKey.shot(shot.id),
        content: shot,
        dependsOn: [
          "aspect",
          ...(shot.beatIds ?? []).map((id) => `beat:${id}`),
          ...(shot.characterIds ?? []).map((id) => `character:${id}`),
          ...(shot.assetIds ?? []).map(nodeKey.asset),
          ...(shot.dependsOn ?? []).map(nodeKey.shot),
        ],
      });
    }
    const { approval, shots, ...own } = scene;
    nodes.push({
      key: nodeKey.scene(scene.id),
      content: { ...own, shotIds: shots.map((s) => s.id) },
      dependsOn: shots.map((s) => nodeKey.shot(s.id)),
    });
  }
  return nodes;
}
