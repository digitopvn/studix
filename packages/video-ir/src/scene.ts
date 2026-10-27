import { z } from "zod";
import { ColorValue, IrId, PositiveMilliseconds } from "./primitives.ts";
import { Shot } from "./shot.ts";

export const SceneRole = z.enum(["hook", "intro", "body", "feature", "proof", "cta", "outro", "custom"]);
export type SceneRole = z.infer<typeof SceneRole>;

export const TransitionKind = z.enum(["cut", "fade", "slide", "wipe", "zoom"]);
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

/** A scene is content only; its absolute placement lives in the timeline. */
export const Scene = z.object({
  id: IrId,
  role: SceneRole,
  durationMs: PositiveMilliseconds,
  background: SceneBackground.optional(),
  shots: z.array(Shot).min(1).max(40),
  transitionOut: SceneTransition.optional(),
  /** Director notes for planners/reviewers; renderers ignore them. */
  notes: z.string().max(1000).optional(),
});
export type Scene = z.infer<typeof Scene>;
