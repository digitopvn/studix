import type { CameraMove, SceneDepth, SceneMotif, SceneTransition, TransitionKind } from "@studix/video-ir";
import type { MotionStyleProfile } from "./motion-style-profiles.ts";

/**
 * Camera and depth grammar of the motion-graphic template: which camera move each card makes, which depth
 * planes and motif a style draws, and how its cards cut into each other. Pure and deterministic.
 */

/** Camera moves a style cycles through, calmest styles drifting, energetic ones pushing and panning. */
const CAMERA_CYCLE: Record<"calm" | "steady" | "lively", readonly CameraMove[]> = {
  calm: ["push-in", "pan-right", "pull-back", "parallax", "pan-left"],
  steady: ["push-in", "parallax", "pan-left", "pull-back", "pan-right"],
  lively: ["push-in", "pan-left", "pull-back", "parallax", "pan-right"],
};

const tempo = (energy: number) => (energy <= 2 ? "calm" : energy === 3 ? "steady" : "lively");

/**
 * One camera move per card: the storyboard's pick when it has one, else the style's cycle. Adjacent cards
 * never share a move: a card whose move repeats the previous card's takes the next move of the cycle that
 * differs from both its neighbours' picks.
 */
export function planCameras(
  wanted: ReadonlyArray<CameraMove | null | undefined>,
  style: MotionStyleProfile,
): CameraMove[] {
  const cycle = CAMERA_CYCLE[tempo(style.energy)];
  const out: CameraMove[] = [];
  wanted.forEach((pick, i) => {
    const prev = out[i - 1];
    const next = wanted[i + 1] ?? undefined;
    // A card the storyboard left open avoids its neighbours' moves, so an explicit pick is kept.
    const free = (m: CameraMove) => m !== prev && m !== next;
    const fromCycle = () =>
      [...cycle.slice(i % cycle.length), ...cycle].find(free) ??
      (cycle.find((m) => m !== prev) as CameraMove);
    out.push(!pick ? fromCycle() : pick === prev ? fromCycle() : pick);
  });
  return out;
}

const DARK = 0.12;

/** WCAG relative luminance of a `#rrggbb[aa]` colour (alpha ignored). */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Styles drawn on a technical sheet or screen get a grid; printed and filmic ones get grain. */
const GRID_STYLES = /blueprint|data|isometric|hud|saas|swiss|terminal|pixel|bento/;
const GRAIN_STYLES =
  /deco|woodblock|ink|retro|newsprint|zine|screenprint|paper|groovy|mid-century|constructivist|luxury|crt/;
const MOTIF_SHAPES: ReadonlyArray<readonly [RegExp, SceneMotif["shape"]]> = [
  [/deco|luxury|neon|hud|holographic|vaporwave/, "ring"],
  [/swiss|data|newsprint|terminal|blueprint|editorial/, "bar"],
  [/brutalist|pixel|zine|constructivist|isometric|bento/, "square"],
];

/**
 * The depth planes and motif a style draws on every card, from the style's look (its id) and surface: a glow
 * and a vignette on dark surfaces, a grid on technical ones, grain on printed or filmic ones, corner brackets
 * on energetic styles and bokeh on calm dark ones. `background` is the surface the cards are painted on.
 */
export function motionDepthFor(
  style: MotionStyleProfile,
  background: string,
): { depth: SceneDepth; motif: SceneMotif } {
  const dark = luminance(background) < DARK;
  const back: NonNullable<SceneDepth["background"]> = [];
  if (dark) back.push("glow");
  if (GRID_STYLES.test(style.id)) back.push("grid");
  if (GRAIN_STYLES.test(style.id)) back.push("grain");
  if (dark && style.energy <= 3) back.push("vignette");
  const front: NonNullable<SceneDepth["foreground"]> =
    style.energy >= 4 ? ["corners"] : dark && style.energy <= 2 ? ["bokeh"] : [];
  const shape =
    MOTIF_SHAPES.find(([re]) => re.test(style.id))?.[1] ?? (style.energy >= 4 ? "square" : "circle");
  return {
    depth: { ...(back.length ? { background: back } : {}), ...(front.length ? { foreground: front } : {}) },
    motif: { shape, color: "accent" },
  };
}

/** Transition vocabulary per tempo that varies the cuts between messages. */
const TRANSITIONS: Record<"calm" | "steady" | "lively", { kinds: readonly TransitionKind[] }> = {
  calm: { kinds: ["fade", "iris", "wipe"] },
  steady: { kinds: ["slide", "wipe", "iris"] },
  lively: { kinds: ["zoom", "whip", "wipe"] },
};

/**
 * The transition out of each card but the last: the cut into the call to action is the style's signature
 * transition (the one its profile locks), the hook hard-cuts into the first message on a match cut (the motif carries the
 * eye across), and the cuts between messages take turns through the rest of the style's vocabulary, so no
 * two adjacent cuts repeat.
 */
export function planTransitions(cards: number, style: MotionStyleProfile): SceneTransition[] {
  // The profile's locked transition is the signature; a hard-cut profile cuts everywhere but the match cut.
  const signature = style.juice.transition;
  const ms = signature.durationMs;
  const kinds: readonly TransitionKind[] =
    signature.kind === "cut"
      ? ["cut", "cut"]
      : [signature.kind, ...TRANSITIONS[tempo(style.energy)].kinds.filter((k) => k !== signature.kind)].slice(
          0,
          3,
        );
  const between = kinds.slice(1);
  return Array.from({ length: Math.max(0, cards - 1) }, (_, i): SceneTransition => {
    if (i === cards - 2) return { kind: kinds[0] as TransitionKind, durationMs: ms };
    if (i === 0) return { kind: "match-cut", durationMs: 0 };
    return { kind: between[(i - 1) % between.length] as TransitionKind, durationMs: ms };
  });
}
