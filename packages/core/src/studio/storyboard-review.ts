import { StudixError } from "@studix/shared";
import {
  type LayoutSpec,
  nodeDigests,
  nodeKey,
  resolveSceneSpans,
  type Shot,
  STORYBOARD_SCHEMA_VERSION,
  type Storyboard,
  type StoryboardApproval,
  type StoryboardScene,
  type VideoIR,
  videoIrNodes,
} from "@studix/video-ir";

/** What a storyboard review decision applies to. */
export type StoryboardTarget =
  | { kind: "storyboard" }
  | { kind: "scene"; id: string }
  | { kind: "shot"; id: string };

/** Node key of a review target, as stored on comments (`storyboard`, `scene:<id>`, `shot:<id>`). */
export function storyboardTargetKey(target: StoryboardTarget): string {
  return target.kind === "storyboard" ? "storyboard" : `${target.kind}:${target.id}`;
}

/** The words a shot puts on screen, when it has any (the script line of the shot). */
export function shotScript(shot: Shot): string | undefined {
  switch (shot.type) {
    case "title":
      return shot.subtitle ? `${shot.text} — ${shot.subtitle}` : shot.text;
    case "text":
    case "cta":
      return shot.text;
    case "logo":
      return shot.text;
    case "layout":
      return layoutWords(shot.layout);
    default:
      return undefined;
  }
}

/** The words a built-in layout shows, in reading order. */
function layoutWords(layout: LayoutSpec): string {
  switch (layout.kind) {
    case "prompt-box":
      return layout.text;
    case "code":
      return layout.lines.join("\n");
    case "chips":
      return `${layout.hub}: ${layout.items.join(", ")}`;
    case "checklist":
      return layout.items.map((i) => i.label).join(", ");
    case "counter":
      return [`${layout.prefix ?? ""}${layout.to}${layout.suffix ?? ""}`, layout.label ?? ""]
        .join(" ")
        .trim();
    case "cards-row":
      return layout.items.join(", ");
    case "swatches":
      return layout.items.map((i) => i.label ?? i.color).join(", ");
    case "stat":
      return `${layout.value} ${layout.label}`;
    case "chat":
      return layout.messages.map((m) => m.text).join("\n");
    case "tool-call":
      return [layout.name, ...(layout.args ?? []).map((a) => `${a.key}: ${a.value}`), layout.result ?? ""]
        .filter(Boolean)
        .join("\n");
    case "pipeline":
      return layout.steps.map((s) => s.label).join(" → ");
    case "player":
      return [layout.title, layout.action ?? ""].filter(Boolean).join(", ");
    case "meter":
      return [`${layout.used} / ${layout.cap}${layout.unit ? ` ${layout.unit}` : ""}`, layout.label ?? ""]
        .filter(Boolean)
        .join(" ");
  }
}

/** One-line reviewer-facing description of a shot. */
export function shotDescription(shot: Shot): string {
  const words = shotScript(shot);
  switch (shot.type) {
    case "image":
      return `Image: ${shot.alt || shot.assetId}`;
    case "video":
      return `Video clip ${shot.assetId}`;
    case "logo":
      return words ? `Logo wordmark "${words}"` : "Brand logo";
    case "cta":
      return shot.url ? `Call to action "${shot.text}" (${shot.url})` : `Call to action "${shot.text}"`;
    case "composition":
      return `Composition ${shot.entry ?? "default"} from ${shot.assetId}`;
    case "layout":
      return `Layout ${shot.layout.kind} "${words}"`;
    default:
      return `${shot.type === "title" ? "Title" : "Text"} "${words}"`;
  }
}

/** Absolute placement of every shot on the video timeline, in document order. */
export interface ShotPlacement {
  sceneId: string;
  shotId: string;
  /** JSON pointer of the shot inside the IR, e.g. `/scenes/0/shots/1`. */
  pointer: string;
  startMs: number;
  endMs: number;
}

export function shotPlacements(ir: VideoIR): ShotPlacement[] {
  const starts = new Map(resolveSceneSpans(ir.timeline, ir.scenes).map((s) => [s.sceneId, s.startMs]));
  return ir.scenes.flatMap((scene, si) =>
    scene.shots.map((shot, i) => {
      const startMs = (starts.get(scene.id) ?? 0) + shot.startMs;
      return {
        sceneId: scene.id,
        shotId: shot.id,
        pointer: `/scenes/${si}/shots/${i}`,
        startMs,
        endMs: startMs + shot.durationMs,
      };
    }),
  );
}

const DRAFT: StoryboardApproval = { status: "draft" };

function sceneTitle(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Storyboard of a VideoIR for packs that plan the IR directly (brand intro): one storyboard scene per IR
 * scene and one storyboard shot per IR shot, every approval in `draft`.
 */
export function storyboardFromVideoIR(ir: VideoIR): Storyboard {
  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    title: ir.title,
    language: ir.language,
    aspectRatio: ir.format.aspectRatio,
    characters: [],
    assets: ir.assets,
    beats: [],
    scenes: ir.scenes.map(
      (scene): StoryboardScene => ({
        id: scene.id,
        title: sceneTitle(scene.role),
        ...(scene.notes ? { summary: scene.notes } : {}),
        shots: scene.shots.map((shot) => ({
          id: shot.id,
          kind: shot.type,
          description: shotDescription(shot),
          durationMs: shot.durationMs,
          ...("assetId" in shot && shot.assetId ? { assetIds: [shot.assetId] } : {}),
          approval: DRAFT,
        })),
        approval: DRAFT,
      }),
    ),
    approval: DRAFT,
  };
}

/** A node whose content changed needs another look: anything but `draft` goes back to `in_review`. */
function afterChange(previous: StoryboardApproval | undefined): StoryboardApproval {
  return previous === undefined || previous.status === "draft" ? DRAFT : { status: "in_review" };
}

/**
 * Storyboard of `nextIr`, keeping the review state of `previous` (which described `previousIr`) for
 * every scene and shot whose dependency digest did not change. A changed node, and the storyboard as a
 * whole when any node changed, goes back to review. Uses the same Merkle digests as scene/shot revisions,
 * so approving never invalidates and editing one shot only reopens that shot and its scene.
 */
export function syncStoryboard(previous: Storyboard, previousIr: VideoIR, nextIr: VideoIR): Storyboard {
  const before = nodeDigests(videoIrNodes(previousIr));
  const after = nodeDigests(videoIrNodes(nextIr));
  const prevScenes = new Map(previous.scenes.map((s) => [s.id, s]));
  const prevShots = new Map(previous.scenes.flatMap((s) => s.shots.map((shot) => [shot.id, shot])));
  const next = storyboardFromVideoIR(nextIr);
  let changed = previous.scenes.length !== next.scenes.length;
  const carry = (key: string, prior: StoryboardApproval | undefined): StoryboardApproval => {
    if (prior !== undefined && before.get(key) === after.get(key)) return prior;
    changed = true;
    return afterChange(prior);
  };
  const scenes = next.scenes.map((scene) => ({
    ...scene,
    shots: scene.shots.map((shot) => ({
      ...shot,
      approval: carry(nodeKey.shot(shot.id), prevShots.get(shot.id)?.approval),
    })),
    approval: carry(nodeKey.scene(scene.id), prevScenes.get(scene.id)?.approval),
  }));
  if (prevShots.size !== scenes.reduce((n, s) => n + s.shots.length, 0)) changed = true;
  return { ...next, scenes, approval: changed ? afterChange(previous.approval) : previous.approval };
}

/** Shot ids of the storyboard whose approval is `changes_requested`. */
export function shotsWithChangesRequested(sb: Storyboard): string[] {
  return sb.scenes.flatMap((s) =>
    s.shots.filter((t) => t.approval.status === "changes_requested").map((t) => t.id),
  );
}

/** Copy of `sb` with `approval` set on the target; NOT_FOUND for an unknown scene or shot. */
export function setStoryboardApproval(
  sb: Storyboard,
  target: StoryboardTarget,
  approval: StoryboardApproval,
): Storyboard {
  if (target.kind === "storyboard") return { ...sb, approval };
  let found = false;
  const scenes = sb.scenes.map((scene) => {
    if (target.kind === "scene") {
      if (scene.id !== target.id) return scene;
      found = true;
      return { ...scene, approval };
    }
    const shots = scene.shots.map((shot) => {
      if (shot.id !== target.id) return shot;
      found = true;
      return { ...shot, approval };
    });
    return { ...scene, shots };
  });
  if (!found) {
    throw new StudixError("NOT_FOUND", `${target.kind} ${target.id} is not in the storyboard`, {
      suggestedAction: "Reload the review page; the storyboard may have changed.",
    });
  }
  return { ...sb, scenes };
}
