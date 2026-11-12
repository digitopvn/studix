import type { VideoIR } from "@studix/video-ir";
import { z } from "zod";
import type { CutGrid } from "./motion-graphic-retime.ts";

/** The shortest section a composition plan may hold (ElevenLabs music refuses shorter ones). */
export const MIN_SECTION_MS = 3000;

/** One section of a music bed's composition plan, as the media provider takes it (`params.sections`). */
export interface MusicSection {
  name: string;
  durationMs: number;
  styles: string[];
}

const INTRO_STYLES = ["sparse soft intro", "establish the groove", "low energy"];
const BUILD_STYLES = ["building energy", "steady driving pulse", "rising tension"];
const DROP_STYLES = ["full drop on the first beat", "peak energy", "strong downbeats", "resolving ending"];

/** Where each card starts on the timeline (ms), and where the CTA card starts (the end when there is none). */
function cardStarts(ir: VideoIR): { starts: number[]; cta: number } {
  let at = 0;
  const starts = ir.scenes.map((sc) => {
    const start = at;
    at += sc.durationMs;
    return start;
  });
  const ctaIndex = ir.scenes.findIndex((sc) => sc.id === "cta");
  return { starts, cta: ctaIndex > 0 ? (starts[ctaIndex] as number) : ir.format.durationMs };
}

/**
 * A composition plan for the graphic's music bed: a soft intro under the hook card, a build under the
 * message cards and the drop where the CTA card starts, so the music peaks on the call to action. Every
 * section is at least `MIN_SECTION_MS`: a hook or CTA card shorter than that takes time from the build, and
 * a graphic too short for three sections keeps the build and the drop (or one section). The sections add up
 * to the graphic's length. Pure.
 */
export function musicSections(ir: VideoIR): MusicSection[] {
  const total = ir.format.durationMs;
  const { starts, cta } = cardStarts(ir);
  if (total < 2 * MIN_SECTION_MS) return [{ name: "drop", durationMs: total, styles: DROP_STYLES }];
  // The drop starts on the CTA card, but never closer to the end than one section.
  const drop = Math.min(Math.max(cta, MIN_SECTION_MS), total - MIN_SECTION_MS);
  const hookEnd = starts[1] ?? drop;
  const intro = Math.max(MIN_SECTION_MS, hookEnd);
  if (drop - intro < MIN_SECTION_MS) {
    return [
      { name: "build", durationMs: drop, styles: [...INTRO_STYLES.slice(0, 1), ...BUILD_STYLES] },
      { name: "drop", durationMs: total - drop, styles: DROP_STYLES },
    ];
  }
  return [
    { name: "intro", durationMs: intro, styles: INTRO_STYLES },
    { name: "build", durationMs: drop - intro, styles: BUILD_STYLES },
    { name: "drop", durationMs: total - drop, styles: DROP_STYLES },
  ];
}

/** The beat grid the music stage keeps in the IR's metadata (`beats`), on the graphic's timeline. */
export const MusicBeats = z.object({
  bpm: z.number().positive().max(400),
  beatsMs: z.array(z.number().int().min(0)).max(2000),
  downbeatsMs: z.array(z.number().int().min(0)).max(1000),
});
export type MusicBeats = z.infer<typeof MusicBeats>;

/** The music bed's beat grid kept in `ir.metadata.beats`, or undefined when the graphic has none. */
export function beatsOf(ir: VideoIR): CutGrid | undefined {
  const parsed = MusicBeats.safeParse(ir.metadata?.beats);
  return parsed.success && parsed.data.downbeatsMs.length > 0 ? parsed.data : undefined;
}
