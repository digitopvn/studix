import { z } from "zod";
import { ColorValue, IrId, PositiveMilliseconds } from "./primitives.ts";
import { Shot } from "./shot.ts";

export const SceneRole = z.enum(["hook", "intro", "body", "feature", "proof", "cta", "outro", "custom"]);
export type SceneRole = z.infer<typeof SceneRole>;

/**
 * How one scene hands over to the next. `whip` is a fast pan with a smear, `iris` opens and closes a circle,
 * and `match-cut` is a hard cut that the scene's motif carries across (both scenes need a motif).
 */
export const TransitionKind = z.enum(["cut", "fade", "slide", "wipe", "zoom", "whip", "iris", "match-cut"]);
export type TransitionKind = z.infer<typeof TransitionKind>;

/** Transition into the next scene; it overlaps the tail of this scene and never extends it. */
export const SceneTransition = z.object({
  kind: TransitionKind,
  durationMs: z.number().int().min(0).max(3000),
});
export type SceneTransition = z.infer<typeof SceneTransition>;

export const SceneBackground = z.object({
  color: ColorValue.optional(),
  /** Image or video asset id from the IR `assets` list. */
  assetId: IrId.optional(),
});
export type SceneBackground = z.infer<typeof SceneBackground>;

/**
 * The camera move a scene plays over its whole length. Content moves as named (`pan-left` drifts it left);
 * `parallax` drifts the depth layers at different rates. Adjacent scenes never share a move other than `static`.
 */
export const CameraMove = z.enum(["static", "push-in", "pull-back", "pan-left", "pan-right", "parallax"]);
export type CameraMove = z.infer<typeof CameraMove>;

export const SceneCamera = z.object({
  move: CameraMove,
  /** Scales how far the camera travels; 1 is a subtle move. */
  intensity: z.number().min(0.25).max(2).optional(),
});
export type SceneCamera = z.infer<typeof SceneCamera>;

/** Texture layers drawn behind the content, back to front in the order listed. */
export const BackgroundLayer = z.enum(["grid", "glow", "grain", "vignette"]);
export type BackgroundLayer = z.infer<typeof BackgroundLayer>;

/** Small accent graphics drawn in front of the content, near the frame edges. */
export const ForegroundAccent = z.enum(["corners", "rule", "dots"]);
export type ForegroundAccent = z.infer<typeof ForegroundAccent>;

export const SceneDepth = z.object({
  background: z.array(BackgroundLayer).max(4).optional(),
  foreground: z.array(ForegroundAccent).max(3).optional(),
});
export type SceneDepth = z.infer<typeof SceneDepth>;

export const MotifShape = z.enum(["circle", "ring", "square", "bar"]);
export type MotifShape = z.infer<typeof MotifShape>;

export const MotifAnchor = z.enum([
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
]);
export type MotifAnchor = z.infer<typeof MotifAnchor>;

/**
 * A persistent shape drawn behind the content. When the previous scene has a motif of the same shape, this
 * scene's motif starts where that one ended and travels to its own anchor, so the shape carries across the
 * cut (the device behind a `match-cut`).
 */
export const SceneMotif = z.object({
  shape: MotifShape,
  anchor: MotifAnchor,
  size: z.enum(["small", "medium", "large"]).optional(),
  color: ColorValue.optional(),
});
export type SceneMotif = z.infer<typeof SceneMotif>;

/** A scene is content only; its absolute placement lives in the timeline. */
export const Scene = z.object({
  id: IrId,
  role: SceneRole,
  durationMs: PositiveMilliseconds,
  background: SceneBackground.optional(),
  shots: z.array(Shot).min(1).max(40),
  transitionOut: SceneTransition.optional(),
  camera: SceneCamera.optional(),
  depth: SceneDepth.optional(),
  motif: SceneMotif.optional(),
  /** Director notes for planners/reviewers; renderers ignore them. */
  notes: z.string().max(1000).optional(),
});
export type Scene = z.infer<typeof Scene>;
