import { z } from "zod";
import { IrId, Milliseconds } from "./primitives.ts";

/** Places a scene on the absolute timeline. */
export const TimelineEntry = z.object({
  sceneId: IrId,
  startMs: Milliseconds,
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const TimelineMarker = z.object({
  id: IrId,
  atMs: Milliseconds,
  label: z.string().min(1).max(120),
});
export type TimelineMarker = z.infer<typeof TimelineMarker>;

/**
 * Scene placement. Invariants (checked by validateVideoIR): every scene appears exactly once, entries
 * are ordered, contiguous from 0 with no gaps or overlaps, and end exactly at format.durationMs.
 */
export const Timeline = z.object({
  entries: z.array(TimelineEntry).min(1).max(100),
  markers: z.array(TimelineMarker).max(100).optional(),
});
export type Timeline = z.infer<typeof Timeline>;

export interface ResolvedSceneSpan {
  sceneId: string;
  startMs: number;
  endMs: number;
}

/** Build a contiguous timeline in the given scene order. */
export function buildSequentialTimeline(scenes: ReadonlyArray<{ id: string; durationMs: number }>): Timeline {
  let cursor = 0;
  const entries = scenes.map((scene) => {
    const entry = { sceneId: scene.id, startMs: cursor };
    cursor += scene.durationMs;
    return entry;
  });
  return { entries };
}

/** Absolute [start, end) span of each placed scene; entries pointing at unknown scenes are skipped. */
export function resolveSceneSpans(
  timeline: Timeline,
  scenes: ReadonlyArray<{ id: string; durationMs: number }>,
): ResolvedSceneSpan[] {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const spans: ResolvedSceneSpan[] = [];
  for (const entry of timeline.entries) {
    const scene = byId.get(entry.sceneId);
    if (scene)
      spans.push({ sceneId: entry.sceneId, startMs: entry.startMs, endMs: entry.startMs + scene.durationMs });
  }
  return spans;
}
