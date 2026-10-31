import { filmOf, shotStarts } from "@studix/skills";
import type { VideoIR } from "@studix/video-ir";
import type { z } from "zod";
import type { ShotBoundariesInput } from "./qa-tools.ts";

type Join = z.input<typeof ShotBoundariesInput>["joins"][number];

/**
 * The joins of a narrative film render for the `shot-boundaries` tool: every cut between two consecutive
 * shots, at its time in the render, judged by the boundary the second shot's production plan promises.
 */
export function filmShotJoins(ir: VideoIR): Join[] {
  const plans = new Map(filmOf(ir).production.shots.map((p) => [p.shotId, p]));
  const starts = shotStarts(ir);
  const order = ir.scenes.flatMap((scene) => scene.shots.map((shot) => shot.id));
  const joins: Join[] = [];
  for (let i = 1; i < order.length; i++) {
    const a = order[i - 1] as string;
    const b = order[i] as string;
    const at = starts.get(b);
    if (!at) continue;
    joins.push({ a, b, atS: at.startMs / 1000, mode: plans.get(b)?.boundary ?? "intentional-cut" });
  }
  return joins;
}
