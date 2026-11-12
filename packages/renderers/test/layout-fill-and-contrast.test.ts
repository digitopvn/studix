import type { LayoutSpec } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { AA_TEXT, contrastRatio, readableInk } from "../src/hyperframes/ink-contrast.ts";
import {
  chipsPlan,
  displayFactorFor,
  FILL_LANDSCAPE_BOOST,
  inkOnAccent,
  LANDSCAPE_LAYOUT_BOOST,
  layoutBoost,
  layoutRoomHeight,
  swatchSize,
} from "../src/hyperframes/layout-markup.ts";
import { ambientMs, CTA_HOLD_MS } from "../src/hyperframes/scene-depth.ts";

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const contentWidth = (f: { width: number; height: number }) =>
  f.width - 2 * Math.round(0.07 * Math.min(f.width, f.height));

describe("layout fill", () => {
  it("boosts short landscape devices most, height-bound panels less, portrait ones not at all", () => {
    const swatches: LayoutSpec = { kind: "swatches", items: [{ color: "primary" }] };
    const code: LayoutSpec = { kind: "code", lines: ["a"] };
    expect(layoutBoost(swatches, LANDSCAPE)).toBe(FILL_LANDSCAPE_BOOST);
    expect(layoutBoost(code, LANDSCAPE)).toBe(LANDSCAPE_LAYOUT_BOOST);
    expect(layoutBoost(swatches, PORTRAIT)).toBe(1);
  });

  it("draws a chip row large while its labels fit one line, else at the smaller boost", () => {
    const short = chipsPlan(["HTTPS /mcp", "Claude", "Cursor"], LANDSCAPE);
    expect(short.boost).toBe(FILL_LANDSCAPE_BOOST);
    expect(short.column).toBe(false);
    // Four 12-character labels would drop under the floor at the large boost: they keep the smaller one.
    const long = chipsPlan(Array(4).fill("abcdefghijkl"), LANDSCAPE);
    expect(long.boost).toBe(LANDSCAPE_LAYOUT_BOOST);
    expect(long.factor).toBeGreaterThanOrEqual(0.6);
  });

  it("sizes swatches to fill the card but keeps them inside its width and height", () => {
    const width = contentWidth(LANDSCAPE);
    const height = layoutRoomHeight(LANDSCAPE);
    const size = swatchSize(3, 3, width, height, FILL_LANDSCAPE_BOOST);
    // Three brand colours in a 16:9 card: each well over the old 275 px, the row over half the frame width.
    expect(size).toBeGreaterThan(300);
    expect(3 * size + 2 * 36 * 1.6).toBeGreaterThan(0.55 * LANDSCAPE.width);
    expect(3 * size + 2 * 36 * 1.6).toBeLessThanOrEqual(width * 0.9 + 1);
    // The square and its label stay inside the height the card leaves under the headline.
    expect(size + (34 * 0.9 * 1.35 + 14) * 1.6).toBeLessThanOrEqual(height);
  });

  it("shrinks swatches in rows to the card's height", () => {
    const height = 600;
    const size = swatchSize(6, 3, 928, height, 1);
    expect(2 * size + 2 * (34 * 0.9 * 1.35 + 14) + 28).toBeLessThanOrEqual(height);
  });

  it("caps a display value so it and the parts under it fit the card's height", () => {
    const height = layoutRoomHeight(LANDSCAPE);
    const scale = FILL_LANDSCAPE_BOOST;
    const factor = displayFactorFor(height, 118, 1.1, scale);
    expect(104 * factor * 1.1 * scale + 118 * scale).toBeCloseTo(height, 5);
  });

  it("leaves the caption band and a two-line headline free in landscape", () => {
    expect(layoutRoomHeight(LANDSCAPE)).toBeGreaterThan(400);
    expect(layoutRoomHeight(LANDSCAPE)).toBeLessThan(LANDSCAPE.height / 2);
    expect(layoutRoomHeight(LANDSCAPE, 100)).toBeCloseTo(layoutRoomHeight(LANDSCAPE) - 100, 5);
  });
});

describe("ink contrast", () => {
  it("computes WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("keeps the first candidate that meets AA", () => {
    expect(readableInk("#0b1020", [["var(--c-foreground)", "#f8fafc"]])).toBe("var(--c-foreground)");
  });

  it("falls back to black or white when no candidate meets AA", () => {
    // A mid gold under both a cream and a mid grey: neither reaches 4.5:1, black does.
    const ink = readableInk("#e0b84a", [
      ["var(--c-foreground)", "#f5ecd0"],
      ["var(--c-background)", "#8a8a8a"],
    ]);
    expect(ink).toBe("#000000");
    expect(contrastRatio(ink, "#e0b84a")).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("sets the hub chip in a palette ink that reads on the accent, else black or white", () => {
    const base = { primary: "#3b82f6", secondary: "#a78bfa", muted: "#94a3b8" };
    // Dark style, gold accent: the dark background reads on it.
    expect(
      inkOnAccent({ palette: { ...base, accent: "#f5c542", background: "#0b1020", foreground: "#f8fafc" } }),
    ).toBe("var(--c-background)");
    // Light gold accent on a light style with a mid ink: neither role reads, black does.
    const pale = { ...base, accent: "#f3d27a", background: "#fff8e6", foreground: "#8c7a5a" };
    expect(inkOnAccent({ palette: pale })).toBe("#000000");
    // A deep accent: white over a mid grey foreground.
    const deep = { ...base, accent: "#3b2a8f", background: "#6b6b6b", foreground: "#9a9a9a" };
    expect(inkOnAccent({ palette: deep })).toBe("#ffffff");
  });
});

describe("CTA hold", () => {
  it("settles the closing card's ambient motion before its last 1.5 s", () => {
    expect(ambientMs({ role: "cta", durationMs: 6000 })).toBe(6000 - CTA_HOLD_MS);
    expect(ambientMs({ role: "cta", durationMs: 2000 })).toBe(1000);
    expect(ambientMs({ role: "feature", durationMs: 6000 })).toBe(6000);
  });
});
