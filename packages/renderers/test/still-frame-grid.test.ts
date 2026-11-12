import { describe, expect, it } from "vitest";
import { MAX_STILL_FPS, planStillGrid } from "../src/index.ts";

describe("planStillGrid", () => {
  it("captures a 60 s, 12-card film as a few dozen frames, every still inside its card's window", () => {
    // 5 s cards, each held from 60% of the card to 150 ms before its end.
    const windows = Array.from({ length: 12 }, (_, i) => ({
      fromMs: i * 5000 + 3000,
      toMs: i * 5000 + 4850,
    }));
    const grid = planStillGrid(windows);
    expect(grid.fps).toBe(1);
    // 60 frames instead of the 1800 of a 30 fps render.
    expect(60 * grid.fps).toBeLessThan(1800 / 20);
    grid.timesMs.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual(windows[i]?.fromMs as number);
      expect(t).toBeLessThanOrEqual(windows[i]?.toMs as number);
    });
  });

  it("takes a finer grid for a short window, and never a frame before the hold", () => {
    expect(planStillGrid([{ fromMs: 1100, toMs: 1450 }])).toEqual({ fps: 3, timesMs: [1333] });
  });

  it("falls back to the finest grid when a window is shorter than its step", () => {
    const grid = planStillGrid([{ fromMs: 1010, toMs: 1050 }]);
    expect(grid.fps).toBe(MAX_STILL_FPS);
    expect(grid.timesMs).toEqual([1000]);
  });
});
