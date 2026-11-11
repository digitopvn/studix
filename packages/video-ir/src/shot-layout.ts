import { z } from "zod";
import { ColorValue } from "./primitives.ts";

/**
 * A motion-design device drawn under the headline of a title or text shot: a typed prompt, a few code
 * lines, labels wired to a source, a checklist, a rolling counter, a row of cards, colour swatches or a
 * big stat. Limits are small on purpose, so every device fits a 9:16, 1:1 or 16:9 frame. A renderer that
 * draws no layouts shows the shot's `text` alone, which is always a complete headline.
 */
const Label = (max: number) => z.string().trim().min(1).max(max);
/** Index of the emphasised entry; must point inside the list (checked on the union). */
const Highlight = z.number().int().min(0).max(5);

export const PromptBoxLayout = z.object({
  kind: z.literal("prompt-box"),
  /** Text typed into the input, then sent. */
  text: Label(120),
});

export const CodeLayout = z.object({
  kind: z.literal("code"),
  lines: z.array(z.string().max(56)).min(1).max(6),
  highlight: Highlight.optional(),
});

export const ChipsLayout = z.object({
  kind: z.literal("chips"),
  /** The block the lines are drawn from. */
  source: Label(32),
  items: z.array(Label(28)).min(2).max(5),
});

export const ChecklistLayout = z.object({
  kind: z.literal("checklist"),
  items: z
    .array(z.object({ text: Label(48), status: Label(16).optional() }))
    .min(2)
    .max(5),
});

export const CounterLayout = z.object({
  kind: z.literal("counter"),
  /** The number as displayed (digits with `.` or `,` separators); each digit rolls up to its value. */
  value: z.string().regex(/^\d(?:[\d.,]{0,10}\d)?$/, "expected digits with optional . or , separators"),
  prefix: Label(6).optional(),
  suffix: Label(8).optional(),
  label: Label(48).optional(),
});

export const CardsRowLayout = z.object({
  kind: z.literal("cards-row"),
  items: z.array(Label(28)).min(2).max(5),
  /** The card that lifts; the last one when omitted. */
  highlight: Highlight.optional(),
});

export const SwatchesLayout = z.object({
  kind: z.literal("swatches"),
  colors: z
    .array(z.object({ color: ColorValue, label: Label(20).optional() }))
    .min(2)
    .max(6),
});

export const StatLayout = z.object({
  kind: z.literal("stat"),
  value: Label(12),
  label: Label(48).optional(),
});

export const SHOT_LAYOUT_KINDS = [
  "prompt-box",
  "code",
  "chips",
  "checklist",
  "counter",
  "cards-row",
  "swatches",
  "stat",
] as const;
export type ShotLayoutKind = (typeof SHOT_LAYOUT_KINDS)[number];

export const ShotLayout = z
  .discriminatedUnion("kind", [
    PromptBoxLayout,
    CodeLayout,
    ChipsLayout,
    ChecklistLayout,
    CounterLayout,
    CardsRowLayout,
    SwatchesLayout,
    StatLayout,
  ])
  .superRefine((layout, ctx) => {
    const size =
      layout.kind === "code" ? layout.lines.length : layout.kind === "cards-row" ? layout.items.length : 0;
    if ("highlight" in layout && layout.highlight !== undefined && layout.highlight >= size) {
      ctx.addIssue({ code: "custom", path: ["highlight"], message: `highlight must be below ${size}` });
    }
  });
export type ShotLayout = z.infer<typeof ShotLayout>;
