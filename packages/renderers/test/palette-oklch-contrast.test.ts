import { describe, expect, it } from "vitest";
import { resolvePalette } from "../src/hyperframes/brand-tokens.ts";
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

  it("applies when a brand kit names only one colour", () => {
    const p = resolvePalette({
      palette: { primary: blue, background: "#111111", foreground: "#ffffff" },
    } as Parameters<typeof resolvePalette>[0]);
    expect(sameColour(p.accent, blue)).toBe(false);
  });
});
