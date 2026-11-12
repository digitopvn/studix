import { z } from "zod";
import { ColorValue, IrId, PositiveMilliseconds } from "./primitives.ts";
import { Shot } from "./shot.ts";

export const SceneRole = z.enum(["hook", "intro", "body", "feature", "proof", "cta", "outro", "custom"]);
export type SceneRole = z.infer<typeof SceneRole>;

/**
 * `iris` opens and closes through a circle, `whip` is a fast lateral move, `match-cut` is a hard cut on which
 * the scenes' `motif` carries over in the same place.
 */
export const TransitionKind = z.enum(["cut", "fade", "slide", "wipe", "zoom", "iris", "whip", "match-cut"]);
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
 * How the virtual camera moves over the whole scene. Layers move by their depth: background layers less than
 * the shots, foreground accents more, so `parallax` separates the planes while the camera drifts sideways.
 */
export const CameraMove = z.enum(["static", "push-in", "pull-back", "pan-left", "pan-right", "parallax"]);
export type CameraMove = z.infer<typeof CameraMove>;

export const BackgroundLayer = z.enum(["grid", "glow", "grain", "vignette"]);
export type BackgroundLayer = z.infer<typeof BackgroundLayer>;
export const ForegroundAccent = z.enum(["corners", "bokeh"]);
export type ForegroundAccent = z.infer<typeof ForegroundAccent>;

/** Decorative planes drawn behind (background) and in front of (foreground) the shots, in palette roles. */
export const SceneDepth = z.object({
  background: z.array(BackgroundLayer).max(4).optional(),
  foreground: z.array(ForegroundAccent).max(2).optional(),
});
export type SceneDepth = z.infer<typeof SceneDepth>;

/**
 * A shape carried across cuts: consecutive scenes with the same motif hand it over where the previous scene
 * left it, so a `match-cut` between them reads as one continuous object.
 */
export const SceneMotif = z.object({
  shape: z.enum(["circle", "ring", "square", "bar"]),
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
  camera: CameraMove.optional(),
  depth: SceneDepth.optional(),
  motif: SceneMotif.optional(),
  /** Director notes for planners/reviewers; renderers ignore them. */
  notes: z.string().max(1000).optional(),
});
export type Scene = z.infer<typeof Scene>;
