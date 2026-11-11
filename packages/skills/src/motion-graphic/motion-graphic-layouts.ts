import { type ColorRole, SHOT_LAYOUT_KINDS, ShotLayout, type ShotLayoutKind } from "@studix/video-ir";

/** The layouts a storyboard beat may pick, in the order the agent's instructions list them. */
export const BEAT_LAYOUTS = SHOT_LAYOUT_KINDS;
export type BeatLayout = ShotLayoutKind;

/** How the storyboard agent fills `items` for each layout; the template parses exactly this. */
export const BEAT_LAYOUT_GUIDE =
  "`layout` (optional) draws a device under the headline; pick the one that shows what the line says, " +
  "use several kinds across the video and leave it null on a beat that is a pure statement. `items` " +
  "(short strings) fill it: prompt-box = [the text typed into an input, then sent]; code = 1-6 code " +
  'lines (<=56 chars), prefix the one to highlight with "> "; chips = [source, 2-5 labels wired to it]; ' +
  'checklist = 2-5 steps that tick on in order, each "step | status" (status optional, <=16 chars); ' +
  'counter = [number as shown, e.g. "1,200+" or "$49", label]; cards-row = 2-5 card labels, prefix the ' +
  'one that lifts with "> "; swatches = 2-6 colours "#rrggbb Name" (or empty for the brand colours); ' +
  "stat = [big value, e.g. 3x or 90%, label]. Labels stay short (<=28 chars), in the brief's language.";

const HIGHLIGHT = /^>\s*/;
const COUNTER = /^(\D{0,6}?)\s*(\d(?:[\d.,]{0,10}\d)?)\s*(\D{0,8})$/u;
const SWATCH = /^(#[0-9a-fA-F]{6})\b\s*(.*)$/;
const BRAND_SWATCHES: readonly ColorRole[] = ["primary", "accent", "foreground", "background"];

const trimmed = (items: readonly string[]) => items.map((i) => i.trim()).filter(Boolean);

/** Splits off the "> " marker: the entries without it and the index of the first marked one. */
function marked(items: readonly string[]): { items: string[]; highlight?: number } {
  const index = items.findIndex((i) => HIGHLIGHT.test(i));
  return {
    items: items.map((i) => i.replace(HIGHLIGHT, "")),
    ...(index >= 0 ? { highlight: index } : {}),
  };
}

/** The raw layout a beat asks for, before the IR schema checks its limits. */
function draft(kind: BeatLayout, items: string[]): unknown {
  switch (kind) {
    case "prompt-box":
      return { kind, text: items[0] };
    case "code": {
      // Code keeps its indentation, so only the highlight marker is stripped.
      const m = marked(items);
      return { kind, lines: m.items, ...(m.highlight !== undefined ? { highlight: m.highlight } : {}) };
    }
    case "chips":
      return { kind, source: items[0], items: items.slice(1) };
    case "checklist":
      return {
        kind,
        items: items.map((item) => {
          const [text, status] = item.split("|").map((p) => p.trim());
          return { text, ...(status ? { status } : {}) };
        }),
      };
    case "counter": {
      const match = COUNTER.exec(items[0] ?? "");
      if (!match) return undefined;
      const [, prefix, value, suffix] = match;
      return {
        kind,
        value,
        ...(prefix?.trim() ? { prefix: prefix.trim() } : {}),
        ...(suffix?.trim() ? { suffix: suffix.trim() } : {}),
        ...(items[1] ? { label: items[1] } : {}),
      };
    }
    case "cards-row": {
      const m = marked(items);
      return { kind, items: m.items, ...(m.highlight !== undefined ? { highlight: m.highlight } : {}) };
    }
    case "swatches": {
      if (items.length === 0) return { kind, colors: BRAND_SWATCHES.map((color) => ({ color })) };
      return {
        kind,
        colors: items.map((item, i) => {
          const match = SWATCH.exec(item);
          if (match) return { color: match[1]!.toLowerCase(), ...(match[2] ? { label: match[2] } : {}) };
          // A bare name labels the brand colour in that slot.
          return { color: BRAND_SWATCHES[i % BRAND_SWATCHES.length], label: item };
        }),
      };
    }
    case "stat":
      return { kind, value: items[0], ...(items[1] ? { label: items[1] } : {}) };
  }
}

/**
 * The IR layout of a storyboard beat, or undefined when it names none or its items do not fit the layout's
 * limits: that beat then renders as the plain headline card, so a sloppy layout never fails the graphic.
 */
export function beatLayout(
  kind: BeatLayout | null | undefined,
  items: readonly string[] | null | undefined,
  palette?: Partial<Record<ColorRole, string>>,
): ShotLayout | undefined {
  if (!kind) return undefined;
  const raw = kind === "code" ? (items ?? []).filter((l) => l.trim()) : trimmed(items ?? []);
  const parsed = ShotLayout.safeParse(draft(kind, [...raw]));
  if (!parsed.success) return undefined;
  const layout = parsed.data;
  // Brand roles that resolve to the same colour (primary often is the accent) are shown once.
  if (layout.kind === "swatches" && palette) {
    const seen = new Set<string>();
    const colors = layout.colors.filter((c) => {
      const hex = (
        c.color.startsWith("#") ? c.color : (palette[c.color as ColorRole] ?? c.color)
      ).toLowerCase();
      if (seen.has(hex)) return false;
      seen.add(hex);
      return true;
    });
    return colors.length >= 2 ? { ...layout, colors } : undefined;
  }
  return layout;
}
