import type { BrandKit, ColorRole, ColorValue, TextStyleRole } from "@studix/video-ir";

export const COLOR_ROLES: readonly ColorRole[] = [
  "primary",
  "secondary",
  "accent",
  "background",
  "foreground",
  "muted",
];

/** Neutral palette for IRs without a brand kit. */
const DEFAULT_PALETTE: Record<ColorRole, string> = {
  primary: "#3b82f6",
  secondary: "#a78bfa",
  accent: "#f59e0b",
  background: "#0b1020",
  foreground: "#f8fafc",
  muted: "#94a3b8",
};

export const DEFAULT_FONT_FAMILY = "Be Vietnam Pro";

/** Every palette role resolved to a hex value; optional brand roles fall back to required ones. */
export function resolvePalette(brand: BrandKit | undefined): Record<ColorRole, string> {
  if (!brand) return { ...DEFAULT_PALETTE };
  const p = brand.palette;
  return {
    primary: p.primary,
    secondary: p.secondary ?? p.primary,
    accent: p.accent ?? p.primary,
    background: p.background,
    foreground: p.foreground,
    muted: p.muted ?? p.foreground,
  };
}

/** CSS value for a colour token: palette roles become stage CSS variables, hex passes through. */
export function cssColor(value: ColorValue): string {
  return value.startsWith("#") ? value : `var(--c-${value})`;
}

export type FontSlot = "heading" | "body" | "mono";

/** Monospace family for code layouts; bundled like the brand fonts (see bundled-fonts.ts). */
export const MONO_FONT_FAMILY = "JetBrains Mono";

export interface TextStyleToken {
  /** Font size in px at a 1080 px short frame edge. */
  sizeAt1080: number;
  weight: number;
  /**
   * Vietnamese stacks up to two diacritics on one vowel (e.g. "Ẩ", "ỗ"), so line heights stay at or
   * above 1.2 to keep marks from colliding with the line above.
   */
  lineHeight: number;
  font: FontSlot;
}

export const TEXT_STYLES: Record<TextStyleRole, TextStyleToken> = {
  display: { sizeAt1080: 104, weight: 800, lineHeight: 1.2, font: "heading" },
  heading: { sizeAt1080: 68, weight: 700, lineHeight: 1.25, font: "heading" },
  body: { sizeAt1080: 44, weight: 400, lineHeight: 1.4, font: "body" },
  caption: { sizeAt1080: 34, weight: 500, lineHeight: 1.35, font: "body" },
};

/**
 * Burned subtitles are read on a phone, often from a landscape frame shown a third of its size, so they are
 * set larger and bolder than the `caption` text style (small labels inside a card): 44 px at a 1080 px short
 * edge, about 15 px when a 16:9 frame fills a phone's width.
 */
export const BURNED_CAPTION: TextStyleToken = { ...TEXT_STYLES.caption, sizeAt1080: 44, weight: 600 };

/** Burned caption chip: its padding (vertical, horizontal) and the frame edge it keeps off, at 1080. */
export const BURNED_CAPTION_PAD = { y: 10, x: 22 } as const;
export const burnedCaptionEdge = (frame: { width: number; height: number }) =>
  Math.round(0.09 * Math.min(frame.width, frame.height));

/**
 * Height of the band burned captions take at the bottom of the frame, from its edge: the edge gap and one cue
 * line on a landscape frame (a cue fits one line there), two on a portrait one.
 */
export function burnedCaptionBand(frame: { width: number; height: number }): number {
  const scale = frameScale(frame);
  const lines = frame.height > frame.width ? 2 : 1;
  const line = BURNED_CAPTION.sizeAt1080 * BURNED_CAPTION.lineHeight * lines + 2 * BURNED_CAPTION_PAD.y;
  return burnedCaptionEdge(frame) + Math.round(line * scale);
}

/** Type scales with the short frame edge so portrait and landscape share one scale. */
export function frameScale(size: { width: number; height: number }): number {
  return Math.min(size.width, size.height) / 1080;
}

export function textSizePx(role: TextStyleRole, scale: number, emphasis?: "none" | "low" | "high"): number {
  const boost = emphasis === "high" ? 1.15 : 1;
  return Math.round(TEXT_STYLES[role].sizeAt1080 * scale * boost);
}
