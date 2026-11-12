/**
 * WCAG contrast for the inks a layout sets on a filled shape (a chip, a pill, a button): the ink is picked
 * from the palette when one of its roles reads on the fill, else pure black or white, so a light brand
 * colour never carries light words and a dark one never carries dark words.
 */

/** WCAG AA for normal text. */
export const AA_TEXT = 4.5;
/** WCAG AA for large text (24 px, or 18.7 px bold, and up). */
export const AA_LARGE = 3;

/** `#rrggbb` (an `#rrggbbaa` is read by its colour alone); anything else is undefined. */
function rgb(hex: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return undefined;
  const v = m[1] as string;
  return [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** WCAG relative luminance of a hex colour; an unparsable colour reads as mid grey. */
export function relativeLuminance(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0.18;
  const lin = (x: number) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio of two hex colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The ink for text on `fill`: the first candidate (in order of preference) that reaches `min`, else the
 * candidate or pure black/white with the highest contrast. Each candidate is `[css, hex]`, so a palette role
 * keeps its CSS variable when it wins.
 */
export function readableInk(
  fill: string,
  candidates: ReadonlyArray<readonly [css: string, hex: string]>,
  min = AA_TEXT,
): string {
  const pass = candidates.find(([, hex]) => contrastRatio(hex, fill) >= min);
  if (pass) return pass[0];
  const all = [...candidates, ["#000000", "#000000"] as const, ["#ffffff", "#ffffff"] as const];
  let best = all[0] as readonly [string, string];
  for (const c of all) if (contrastRatio(c[1], fill) > contrastRatio(best[1], fill)) best = c;
  return best[0];
}
