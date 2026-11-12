import type { Shot } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { resolvePalette, withBrandSwatches } from "../src/hyperframes/brand-tokens.ts";
import { sameColour, shiftHue, withContrastingRoles } from "../src/hyperframes/palette-oklch-contrast.ts";

const blue = "#4a86ff";

describe("palette contrast", () => {
  it("derives a complementary accent and an analogous secondary when both collapse onto the primary", () => {
    const out = withContrastingRoles({ primary: blue, secondary: blue, accent: blue });
    expect(out.primary).toBe(blue);
    expect(out.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(sameColour(out.accent, blue)).toBe(false);
    expect(sameColour(out.secondary, blue)).toBe(false);
    expect(sameColour(out.secondary, out.accent)).toBe(false);
    // A complementary of a blue is warm: more red than blue.
    const n = Number.parseInt(out.accent.slice(1), 16);
    expect(n >> 16).toBeGreaterThan(n & 255);
  });

  it("keeps a palette whose roles already differ", () => {
    const palette = { primary: blue, secondary: "#a78bfa", accent: "#f59e0b" };
    expect(withContrastingRoles(palette)).toBe(palette);
  });

  it("returns the colour itself for a zero shift and leaves an unparsable colour alone", () => {
    expect(sameColour(shiftHue(blue, 0), blue)).toBe(true);
    expect(shiftHue("red", 180)).toBe("red");
  });

  it("drops swatches of palette roles the brand kit does not really give", () => {
    const brand = {
      palette: { primary: blue, accent: blue, background: "#111111", foreground: "#ffffff" },
    } as Parameters<typeof resolvePalette>[0];
    const items = [
      { color: "primary", label: "Primary" },
      { color: "accent", label: "Accent" },
      { color: "secondary", label: "Secondary" },
      { color: "foreground", label: "Type" },
      { color: "#123456", label: "Hex" },
    ];
    const shot = {
      id: "sw",
      type: "layout",
      startMs: 0,
      durationMs: 1000,
      layout: { kind: "swatches", items },
    } as unknown as Shot; // a minimal layout shot; only `layout.items` matters here
    const out = withBrandSwatches(shot, brand);
    const labels = out.type === "layout" && out.layout.kind === "swatches" ? out.layout.items : [];
    expect(labels.map((i) => i.label)).toEqual(["Primary", "Type", "Hex"]);
    expect(withBrandSwatches(shot, undefined)).toBe(shot);
  });

  it("applies when a brand kit names only one colour", () => {
    const p = resolvePalette({
      palette: { primary: blue, background: "#111111", foreground: "#ffffff" },
    } as Parameters<typeof resolvePalette>[0]);
    expect(sameColour(p.accent, blue)).toBe(false);
  });
});
