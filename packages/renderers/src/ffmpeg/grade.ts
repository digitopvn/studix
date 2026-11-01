/**
 * Colour looks ported from anime-creator `grade_filter_graph.LOOKS`. Each is a plain FFmpeg chain; the
 * grade runs in planar RGB (blending in YUV once turned a whole run magenta) and returns to yuv420p for
 * H.264.
 */
export const GRADE_LOOKS = {
  /** Warm afternoon. */
  warm: "eq=contrast=1.03:saturation=1.05:gamma=0.99,colorbalance=rs=0.015:bs=-0.01:rh=0.02:gh=0.005:bh=-0.015",
  /** Only a touch of contrast. */
  neutral: "eq=contrast=1.02:saturation=1.02",
  /** Moonlight: cool shadows, slightly lifted blacks. */
  night:
    "eq=contrast=1.04:saturation=0.95:gamma=1.02,colorbalance=rs=-0.02:bs=0.03:rm=-0.01:bm=0.015:rh=0.01:bh=-0.005",
  /** Dusk fire: orange highs, teal lows. */
  dusk: "eq=contrast=1.05:saturation=1.08,colorbalance=rs=-0.015:bs=0.025:rh=0.035:gh=0.01:bh=-0.03",
} as const;

export type GradeLook = keyof typeof GRADE_LOOKS;

export function isGradeLook(value: string): value is GradeLook {
  return Object.hasOwn(GRADE_LOOKS, value);
}

/** Video filter for a named look. Only named looks are accepted, so callers never inject raw filters. */
export function gradeFilter(look: GradeLook): string {
  return `format=gbrp,${GRADE_LOOKS[look]},format=yuv420p`;
}
