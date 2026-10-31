import type { ValidationIssue } from "@studix/video-ir";
import { createFilmPack } from "./film-pack.ts";
import { isVideoTier, type ScopeRule, TIER_RENDER_CLASS } from "./film-scope.ts";

/** Seedance-class clips morph limbs after about 4 s; a full-action T3 stays at or under it. */
export const ANIME_T3_MAX_MS = 4_000;
/** A T2 insert shorter than this reads as a flash, not a shot. */
export const ANIME_T2_MIN_MS = 3_000;
/** Share of a dialogue scene's runtime that moves as video, so talk never plays over held stills. */
export const ANIME_DIALOGUE_MOTION_SHARE = 0.6;

const issue = (path: string, code: ValidationIssue["code"], message: string): ValidationIssue => ({
  path,
  code,
  message,
});

/** Anime routes spend by tier: the render class follows the tier, one T3 per scene, clip lengths in band. */
export const animeRules: readonly ScopeRule[] = [
  (scope) =>
    scope.scenes.flatMap((scene, si) => {
      const out: ValidationIssue[] = [];
      const heroes = scene.shots.filter((s) => s.tier === "T3");
      if (heroes.length > 1)
        out.push(
          issue(
            `/scenes/${si}/shots`,
            "out_of_bounds",
            `${heroes.length} T3 shots; a scene takes at most one`,
          ),
        );
      const runtime = scene.shots.reduce((n, s) => n + s.durationMs, 0);
      const moving = scene.shots.filter((s) => isVideoTier(s.tier)).reduce((n, s) => n + s.durationMs, 0);
      if (scene.shots.some((s) => s.lines.length > 0) && moving < runtime * ANIME_DIALOGUE_MOTION_SHARE)
        out.push(
          issue(
            `/scenes/${si}/shots`,
            "out_of_bounds",
            `a dialogue scene moves as video (T2/T3) for at least ${ANIME_DIALOGUE_MOTION_SHARE * 100}% of its runtime; this one ${Math.round((moving / runtime) * 100)}%`,
          ),
        );
      scene.shots.forEach((shot, i) => {
        const path = `/scenes/${si}/shots/${i}`;
        if (shot.renderClass !== TIER_RENDER_CLASS[shot.tier])
          out.push(
            issue(`${path}/renderClass`, "schema", `${shot.tier} renders as ${TIER_RENDER_CLASS[shot.tier]}`),
          );
        if (shot.tier === "T3" && shot.durationMs > ANIME_T3_MAX_MS)
          out.push(
            issue(
              `${path}/durationMs`,
              "out_of_bounds",
              `a T3 shot lasts at most ${ANIME_T3_MAX_MS / 1000}s`,
            ),
          );
        if (shot.tier === "T2" && shot.durationMs < ANIME_T2_MIN_MS)
          out.push(
            issue(
              `${path}/durationMs`,
              "out_of_bounds",
              `a T2 shot lasts at least ${ANIME_T2_MIN_MS / 1000}s`,
            ),
          );
      });
      return out;
    }),
];

/**
 * Anime episode or scene: series bible and tiered beat sheet (G0), model sheets and set frames (G1), a
 * storyboard of keyframes conditioned on the approved sheets, then on an approved storyboard the dialogue
 * master, motion (film-engine scenes for T0/T1, 480p image-to-video for T2/T3), the lip-sync pass, score and
 * SFX, the continuity check (G3), render and QA (G4).
 */
export const animePack = createFilmPack({
  id: "anime",
  title: "Anime",
  description:
    "Anime episode or scene from a brief: series bible, tiered shots (T0 code, T1 stills, T2/T3 video), " +
    "human-approved scope (G0) and designs (G1), storyboard, dialogue with lip-sync, score and SFX.",
  version: 1,
  defaultDurationMs: 15_000,
  rules: animeRules,
  gates: {
    g0: "Approve the anime scope lock: series bible, characters, sets, and the beat sheet with each shot's tier and lines.",
    g1: "Approve the character model sheets and set frames; every keyframe and clip is drawn from them.",
  },
  scopeInstructions:
    "Anime house rules. Style: 2D cel-shaded anime with clean line art and painted backgrounds. Route by " +
    "tier: per 15 s aim for about half the runtime in T0 (sets, weather, light) and T1 (stills with a push), " +
    "several T2 inserts and at most one T3 per scene; a dialogue scene moves as T2/T3 for at least 60% of " +
    "its runtime. The render class follows the tier (T0 CHEAP_BROLL, T1 STANDARD, T2 CHARACTER_CRITICAL, T3 " +
    "HERO). T2 shots last 3 s or more, T3 4 s or less. Never hold a still longer than 1.5 s without camera " +
    "motion. Write handedness and the contact point of every grip; scope props per shot, every other shot " +
    "has empty hands. Stage the scene once (seats, sides, direction of travel) and keep it in the " +
    "continuity state. Use state.weather (petal, sakura, snow, ember, leaf or ash) for drifting particles.",
  storyboardInstructions:
    "Anime boards: perspective sets with depth and a ground plane, feet on the ground with contact " +
    "shadows, 8% margin at the frame edges, one clear action per panel. T3 motion is a single action that " +
    "ends on a readable pose; T2 motion is a small acting beat or a mouth on its one line.",
  knowledge: {
    scope: ["narrative", "creative-direction", "composition-timing"],
    designs: ["art-direction", "wardrobe-props"],
    storyboard: ["dop-camera", "art-direction", "composition-timing"],
    motion: ["dop-camera", "physics-lite", "production-failure-modes"],
    sound: ["sound", "voice-performance"],
    qa: ["production-failure-modes", "sound"],
  },
});
