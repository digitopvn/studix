import type { ColorRole, ColorValue, ShotLayout } from "@studix/video-ir";
import { cssColor, type FontSlot } from "./brand-tokens.ts";
import { num } from "./html-utils.ts";
import type { TimelineWriter } from "./scene-timeline.ts";
import type { ShotMarkupContext } from "./shot-markup.ts";

/**
 * Shared measures, colours and timing of the layout devices (`shot-layouts.ts`). Everything is derived from
 * the frame and the shot window, never from wall-clock time or randomness, so every capture is identical.
 */
export interface LayoutKit {
  ctx: ShotMarkupContext;
  /** `#<shot dom id>`: every selector of a device is scoped under it. */
  sel: string;
  /**
   * px at a 1080 px short frame edge -> px in this frame. A landscape frame scales its devices up by the
   * square root of its aspect (at most `LANDSCAPE_BOOST_MAX`), so a 16:9 device fills the width it has.
   */
  px: (n: number) => number;
  portrait: boolean;
  /** Width a device may take inside the safe margins. */
  width: number;
  colors: {
    surface: string;
    line: string;
    muted: string;
    /** Accent as ink on the scene background, or the foreground when the accent would not read. */
    accentInk: string;
    /** Black or white, whichever reads on an accent fill. */
    onAccent: string;
    accentTint: string;
  };
  /** CSS for one font slot at a size and weight; registers the weight so its file is bundled. */
  font: (slot: FontSlot, sizeAt1080: number, weight: number) => string[];
  /** Resolves a colour token to hex (for labels) when the palette is known. */
  hex: (value: ColorValue) => string | undefined;
}

/** When a device animates inside its shot window, in seconds. */
export interface LayoutTiming {
  /** Shot start. */
  start: number;
  /** The device starts while the headline settles (overlap). */
  t0: number;
  /** Time the main choreography may take. */
  budget: number;
  /** Where the hold starts and the exit begins. */
  holdStart: number;
  holdEnd: number;
}

export interface LayoutDevice {
  html: string;
  css: string[];
  motion: (w: TimelineWriter, timing: LayoutTiming) => void;
}

/** Seconds rounded like every other timeline value, so output never carries float noise. */
export const sec = (n: number): number => Number(num(n));

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two `#rrggbb[aa]` colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for large text and graphics. */
const MIN_CONTRAST = 3;

/** Largest extra scale a wide frame gives its devices (a 16:9 frame gets about 1.33). */
const LANDSCAPE_BOOST_MAX = 1.35;
/** Share of a landscape frame's width a device may take: enough to read as a film, not a mockup. */
const LANDSCAPE_WIDTH_SHARE = 0.62;

export function layoutKit(ctx: ShotMarkupContext, sel: string): LayoutKit {
  const { width, height } = ctx.frame;
  const short = Math.min(width, height);
  const safe = Math.round(0.07 * short);
  const landscape = width > height;
  const boost = landscape ? clamp(Math.sqrt(width / height), 1, LANDSCAPE_BOOST_MAX) : 1;
  const px = (n: number) => Math.round(n * ctx.scale * boost);
  const palette = ctx.palette;
  const accentInk =
    palette && contrastRatio(palette.accent, palette.background) < MIN_CONTRAST
      ? cssColor("foreground")
      : cssColor("accent");
  const onAccent =
    palette && contrastRatio(palette.accent, "#000000") < contrastRatio(palette.accent, "#ffffff")
      ? "#ffffff"
      : "#000000";
  return {
    ctx,
    sel,
    px,
    portrait: height > width,
    width: landscape
      ? Math.min(width - 2 * safe, Math.round(LANDSCAPE_WIDTH_SHARE * width))
      : Math.min(width - 2 * safe, px(1240)),
    colors: {
      surface: "color-mix(in srgb, var(--c-foreground) 8%, var(--c-background))",
      line: "color-mix(in srgb, var(--c-foreground) 20%, transparent)",
      muted: "color-mix(in srgb, var(--c-foreground) 60%, transparent)",
      accentInk,
      onAccent,
      accentTint: "color-mix(in srgb, var(--c-accent) 16%, transparent)",
    },
    font: (slot, size, weight) => {
      ctx.fontWeights[slot].add(weight);
      return [
        `font-family: ${ctx.fontStacks[slot]};`,
        `font-size: ${px(size)}px;`,
        `font-weight: ${weight};`,
      ];
    },
    hex: (value) => (value.startsWith("#") ? value.slice(0, 7) : palette?.[value as ColorRole]?.slice(0, 7)),
  };
}

/**
 * The device's window inside a shot: it starts shortly after the headline (overlapping its entrance), its
 * choreography takes about half the shot (clamped so a 2 s card still lands and a 9 s card does not crawl),
 * and the rest is the hold, which ends where the shot's exit begins.
 */
export function layoutTiming(startMs: number, durationMs: number, exitMs: number): LayoutTiming {
  const start = startMs / 1000;
  const dur = durationMs / 1000;
  const t0 = sec(start + clamp(dur * 0.1, 0.15, 0.35));
  const holdEnd = sec(start + dur - exitMs / 1000);
  const budget = sec(clamp(Math.min(dur * 0.5, holdEnd - t0), 0.5, 2.6));
  return { start: sec(start), t0, budget, holdStart: sec(t0 + budget), holdEnd };
}

/** Grapheme clusters, so a Vietnamese letter with its marks is typed as one key press. */
export function graphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter("vi", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text.normalize("NFC")), (s) => s.segment);
}

/** Small layout guard: a renderer that draws a device also needs its kind to be known. */
export type LayoutOf<K extends ShotLayout["kind"]> = Extract<ShotLayout, { kind: K }>;
