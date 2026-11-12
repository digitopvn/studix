/**
 * Palette repair in OKLCH. A brand extraction can collapse `secondary` and `accent` onto `primary` (one blue
 * for the whole film), which leaves emphasis with no contrast. When a role sits too close to `primary`, it is
 * derived from `primary` by a hue shift at the same lightness, so emphasis always reads as a second colour.
 */

type Lab = { L: number; a: number; b: number };

/** `#rrggbb`, or `#rrggbbaa` read by its colour alone: the alpha does not change which colour it is. */
const HEX = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i;

/** OKLab distance under which two colours read as the same colour. */
const SAME_COLOUR = 0.08;
/** Hue shifts (degrees) of a derived role: the accent is complementary, the secondary analogous. */
const ACCENT_SHIFT = 180;
const SECONDARY_SHIFT = 40;
/** A derived role is saturated enough to read as a colour, not a grey. */
const MIN_CHROMA = 0.12;

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToLab(hex: string): Lab | undefined {
  const m = HEX.exec(hex);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  };
}

/** Linear sRGB of an OKLab colour; components may fall outside 0..1 when it is out of gamut. */
function labToLinear({ L, a, b }: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: readonly number[]) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

function linearToHex(rgb: readonly number[]): string {
  return `#${rgb
    .map((c) =>
      Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `hex` turned by `degrees` of OKLCH hue at the same lightness, its chroma reduced only to fit sRGB. */
export function shiftHue(hex: string, degrees: number): string {
  const lab = hexToLab(hex);
  if (!lab) return hex;
  const hue = Math.atan2(lab.b, lab.a) + (degrees * Math.PI) / 180;
  let chroma = Math.max(MIN_CHROMA, Math.hypot(lab.a, lab.b));
  // Lower the chroma until the colour fits sRGB: the hue and the lightness are what keep the contrast.
  for (let i = 0; i < 40; i++) {
    const rgb = labToLinear({ L: lab.L, a: chroma * Math.cos(hue), b: chroma * Math.sin(hue) });
    if (inGamut(rgb)) return linearToHex(rgb);
    chroma *= 0.92;
  }
  return linearToHex(labToLinear({ L: lab.L, a: 0, b: 0 }));
}

/** Whether two hex colours read as the same colour (OKLab distance); unparsable colours never do. */
export function sameColour(x: string, y: string): boolean {
  const a = hexToLab(x);
  const b = hexToLab(y);
  if (!a || !b) return false;
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b) < SAME_COLOUR;
}

/**
 * The palette with `accent` (complementary hue) and `secondary` (analogous hue) derived from `primary`
 * wherever they collapse onto it; a palette whose roles already differ is returned unchanged.
 */
export function withContrastingRoles<P extends { primary: string; secondary: string; accent: string }>(
  palette: P,
): P {
  const { primary } = palette;
  const accent = sameColour(palette.accent, primary) ? shiftHue(primary, ACCENT_SHIFT) : palette.accent;
  const secondary = sameColour(palette.secondary, primary)
    ? shiftHue(primary, SECONDARY_SHIFT)
    : palette.secondary;
  return accent === palette.accent && secondary === palette.secondary
    ? palette
    : { ...palette, accent, secondary };
}
