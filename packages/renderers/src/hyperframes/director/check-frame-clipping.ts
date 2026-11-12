import { z } from "zod";

/**
 * Text and UI an authored scene pushes past the frame edge, read from the `hyperframes check --json`
 * report. The check samples the scene in a browser and reports such findings as info only (it exits 0), so
 * a camera push-in that cuts a prompt bar at the left edge would otherwise render as is and read as a bug.
 */

/** Layout finding codes that mean visible content leaves the frame. */
const FRAME_CODES = new Set(["canvas_overflow", "panel_out_of_canvas", "text_box_overflow"]);
/** Pixels past the edge that still read as on the edge (anti-aliasing, a letter's side bearing). */
const FRAME_TOLERANCE_PX = 8;
/** Most problems reported back: the builder fixes a cause, not every sampled word. */
const MAX_PROBLEMS = 6;

/** An element box as the check reports it, in canvas pixels. */
const Rect = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });
const Finding = z.object({
  code: z.string(),
  time: z.number().optional(),
  selector: z.string().optional(),
  containerSelector: z.string().optional(),
  text: z.string().optional(),
  overflow: z.record(z.string(), z.number()).optional(),
  rect: Rect.optional(),
  containerRect: Rect.optional(),
});
const Report = z.object({
  layout: z.object({ findings: z.array(z.unknown()) }).optional(),
});

/** The frame root the shell renders every scene in. */
const FRAME_ROOT = "#root";

/** Whether `rect` lies wholly outside `frame`: off-frame before an entrance or after an exit, never cut. */
const offFrame = (rect: z.infer<typeof Rect>, frame: z.infer<typeof Rect>) =>
  rect.right <= frame.left ||
  rect.left >= frame.right ||
  rect.bottom <= frame.top ||
  rect.top >= frame.bottom;

/**
 * Problems for every element with text that the check found cut by the frame edge, one per element (the
 * widest overflow it reached), at most `MAX_PROBLEMS`. A report that is not a check report gives none: the
 * findings are advisory, never a reason to lose a rendered clip.
 */
export function frameClippingProblems(report: unknown): string[] {
  const parsed = Report.safeParse(report);
  if (!parsed.success) return [];
  const worst = new Map<string, { px: number; side: string; time: number; text: string }>();
  for (const raw of parsed.data.layout?.findings ?? []) {
    const f = Finding.safeParse(raw);
    if (!f.success || !FRAME_CODES.has(f.data.code)) continue;
    const { selector, containerSelector, text, overflow, time } = f.data;
    // A text box overflowing its own card is the card's layout, not the frame edge.
    if (f.data.code === "text_box_overflow" && containerSelector !== FRAME_ROOT) continue;
    const words = text?.trim() ?? "";
    if (!selector || words === "" || !overflow) continue;
    const [side, px] = Object.entries(overflow).reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0]);
    if (px <= FRAME_TOLERANCE_PX) continue;
    // Only a partly visible element reads as cut; one wholly off the frame is mid entrance or exit.
    const { rect, containerRect } = f.data;
    if (rect && containerRect && containerSelector === FRAME_ROOT && offFrame(rect, containerRect)) continue;
    // One entry per element: the shell's `.w` word spans report one by one, so key them by their line.
    const element = selector.replace(/(?:\s*>\s*span:nth-of-type\(\d+\))+$/, "");
    const prev = worst.get(element);
    if (!prev || px > prev.px) worst.set(element, { px, side, time: time ?? 0, text: words });
  }
  return [...worst.entries()]
    .sort((a, b) => b[1].px - a[1].px)
    .slice(0, MAX_PROBLEMS)
    .map(
      ([selector, w]) =>
        `layout: "${w.text.slice(0, 40)}" (${selector}) is cut ${Math.round(w.px)}px past the ${w.side} frame ` +
        `edge at ${w.time.toFixed(2)}s; keep text and UI inside the frame margin at every moment, camera moves included`,
    );
}
