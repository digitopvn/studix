/** A span of the film in which one still should be taken: the first moment that shows it, and the last. */
export interface StillWindow {
  fromMs: number;
  toMs: number;
}

/** The coarse frame grid a stills capture renders, and where each still sits on it. */
export interface StillFrameGrid {
  /** Capture rate: frames per second of the coarse grid. */
  fps: number;
  /** One still per window, on the grid: the first grid frame at or after `fromMs`. */
  timesMs: number[];
}

/** Highest rate a stills capture renders at; the full render runs at 24 to 60 fps. */
export const MAX_STILL_FPS = 6;

/**
 * The lowest frame rate (1 to MAX_STILL_FPS) whose grid has a frame inside every window, and that frame per
 * window. A still only moves later than `fromMs`, never earlier: a layout that enters mid-card would be
 * missing from an earlier frame. When no rate fits every window (a window shorter than the finest step),
 * the finest rate is used and such a window takes its last grid frame before `toMs` (or `fromMs` itself
 * rounded down, when none).
 */
export function planStillGrid(windows: readonly StillWindow[]): StillFrameGrid {
  const snap = (fps: number, w: StillWindow) => Math.ceil((w.fromMs * fps) / 1000) * (1000 / fps);
  for (let fps = 1; fps <= MAX_STILL_FPS; fps++) {
    const times = windows.map((w) => snap(fps, w));
    if (times.every((t, i) => t <= (windows[i] as StillWindow).toMs)) {
      return { fps, timesMs: times.map(Math.round) };
    }
  }
  const step = 1000 / MAX_STILL_FPS;
  return {
    fps: MAX_STILL_FPS,
    timesMs: windows.map((w) => {
      const t = snap(MAX_STILL_FPS, w);
      return Math.round(t <= w.toMs ? t : Math.floor(Math.max(w.toMs, w.fromMs) / step) * step);
    }),
  };
}
