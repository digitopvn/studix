import { z } from "zod";
import { ColorValue } from "./primitives.ts";

/**
 * Built-in visual layouts a `layout` shot draws: product devices a motion graphic shows besides its headline.
 * Each kind carries only typed content (no positions, no CSS); how it is drawn and animated is the renderer's
 * concern, so the IR stays renderer-neutral. Text is short by design: a layout is read in a few seconds.
 */
const Label = (max: number) => z.string().trim().min(1).max(max);

/** A prompt being typed into an input box, then sent. */
export const PromptBoxLayout = z.object({
  kind: z.literal("prompt-box"),
  text: Label(160),
});

/** A few lines of code (for example a config file), one of them highlighted. */
export const CodeLayout = z.object({
  kind: z.literal("code"),
  /** Shown above the code, such as a file name ("mcp.json"). */
  title: Label(40).optional(),
  lines: z.array(z.string().max(64)).min(1).max(8),
  /** 0-based index of the highlighted line. */
  highlight: z.number().int().min(0).max(7).optional(),
});

/** Labels wired to one hub (for example a server connected to several clients). */
export const ChipsLayout = z.object({
  kind: z.literal("chips"),
  hub: Label(32),
  items: z.array(Label(24)).min(2).max(5),
});

/** Steps of a flow and where each stands. */
export const ChecklistLayout = z.object({
  kind: z.literal("checklist"),
  items: z
    .array(z.object({ label: Label(48), state: z.enum(["done", "active", "todo"]) }))
    .min(2)
    .max(5),
});

/** A whole number rolling from `from` to `to`, odometer style. */
export const CounterLayout = z.object({
  kind: z.literal("counter"),
  from: z.number().int().min(0).max(999_999_999),
  to: z.number().int().min(0).max(999_999_999),
  prefix: Label(4).optional(),
  suffix: Label(8).optional(),
  label: Label(60).optional(),
});

/** A row of cards, one of them in focus. */
export const CardsRowLayout = z.object({
  kind: z.literal("cards-row"),
  items: z.array(Label(40)).min(2).max(5),
  /** 0-based index of the card in focus. */
  focus: z.number().int().min(0).max(4).optional(),
});

/** Brand colours, each with an optional name. */
export const SwatchesLayout = z.object({
  kind: z.literal("swatches"),
  colors: z
    .array(z.object({ color: ColorValue, name: Label(24).optional() }))
    .min(2)
    .max(6),
});

/** One big figure and what it measures. */
export const StatLayout = z.object({
  kind: z.literal("stat"),
  value: Label(12),
  label: Label(60),
});

export const LAYOUT_KINDS = [
  "prompt-box",
  "code",
  "chips",
  "checklist",
  "counter",
  "cards-row",
  "swatches",
  "stat",
] as const;
export const LayoutKind = z.enum(LAYOUT_KINDS);
export type LayoutKind = z.infer<typeof LayoutKind>;

/**
 * A layout's content, with every field checked on its own. `Layout` adds the cross-field checks; a planner
 * that parses agent output with this one can repair those (see `Layout`) instead of failing the run.
 */
export const LayoutContent = z.discriminatedUnion("kind", [
  PromptBoxLayout,
  CodeLayout,
  ChipsLayout,
  ChecklistLayout,
  CounterLayout,
  CardsRowLayout,
  SwatchesLayout,
  StatLayout,
]);
export type LayoutContent = z.infer<typeof LayoutContent>;

/** A layout whose indexes point inside its lists. */
export const Layout = LayoutContent.superRefine((layout, ctx) => {
  if (layout.kind === "code" && layout.highlight !== undefined && layout.highlight >= layout.lines.length)
    ctx.addIssue({ code: "custom", path: ["highlight"], message: "highlight is past the last line" });
  if (layout.kind === "cards-row" && layout.focus !== undefined && layout.focus >= layout.items.length)
    ctx.addIssue({ code: "custom", path: ["focus"], message: "focus is past the last card" });
});
export type Layout = z.infer<typeof Layout>;

/** The words a layout puts on screen, in reading order, joined by " · " (for review and search). */
export function layoutText(layout: LayoutContent): string {
  switch (layout.kind) {
    case "prompt-box":
      return layout.text;
    case "code":
      return [layout.title, ...layout.lines].filter((l) => l?.trim()).join(" · ");
    case "chips":
      return [layout.hub, ...layout.items].join(" · ");
    case "checklist":
      return layout.items.map((i) => `${i.label} (${i.state})`).join(" · ");
    case "counter":
      return [`${layout.prefix ?? ""}${layout.to}${layout.suffix ?? ""}`, layout.label ?? ""]
        .filter(Boolean)
        .join(" · ");
    case "cards-row":
      return layout.items.join(" · ");
    case "swatches":
      return layout.colors.map((c) => c.name ?? c.color).join(" · ");
    case "stat":
      return `${layout.value} · ${layout.label}`;
  }
}
