import type { ValidationIssue } from "@studix/video-ir";
import { createFilmPack } from "./film-pack.ts";
import { isVideoTier, type ScopeRule } from "./film-scope.ts";

const CHEAP_CLASSES = new Set(["PREVIS", "CHEAP_BROLL"]);
const LIPSYNC_CLASSES = new Set(["CHARACTER_CRITICAL", "HERO"]);

/**
 * Long-form routing: spend follows the render class, not the tier. A cheap insert never gets a video
 * model, a lip-synced close-up is character-critical or hero, and continuity is a chain inside each scene.
 */
export const longFormFilmRules: readonly ScopeRule[] = [
  (scope) =>
    scope.scenes.flatMap((scene, si) =>
      scene.shots.flatMap((shot, i): ValidationIssue[] => {
        const path = `/scenes/${si}/shots/${i}`;
        const out: ValidationIssue[] = [];
        if (CHEAP_CLASSES.has(shot.renderClass) && isVideoTier(shot.tier))
          out.push({
            path: `${path}/tier`,
            code: "schema",
            message: `a ${shot.renderClass} shot never takes a video model (${shot.tier})`,
          });
        if (shot.lipsync === "dedicated" && !LIPSYNC_CLASSES.has(shot.renderClass))
          out.push({
            path: `${path}/renderClass`,
            code: "lipsync",
            message: `a lip-synced shot is CHARACTER_CRITICAL or HERO, not ${shot.renderClass}`,
          });
        if (i > 0 && !shot.continuityFrom)
          out.push({
            path: `${path}/continuityFrom`,
            code: "continuity",
            message: "every shot after a scene's first carries state from an earlier shot (continuityFrom)",
          });
        return out;
      }),
    ),
];

/**
 * Long-form narrative film as a production graph: screenplay beats, scenes and shots with continuity links,
 * bibles with canonical reference packs (G0, G1), a storyboard of keyframes, then audio-first dialogue,
 * routed shot generation, the lip-sync pass, separate stems, the continuity check and QA.
 */
export const longFormFilmPack = createFilmPack({
  id: "long-form-film",
  title: "Long-form film",
  description:
    "Narrative or episodic film from a brief as a production graph: consistent characters, shot continuity, " +
    "storyboard, audio-first lip-synced dialogue, separate sound stems and render-class model routing.",
  version: 1,
  defaultDurationMs: 60_000,
  rules: longFormFilmRules,
  gates: {
    g0: "Approve the screenplay scope: characters, locations, scenes and shots with their render class and lines.",
    g1: "Approve the canonical reference packs (character sheets and location frames) every shot is conditioned on.",
  },
  scopeInstructions:
    "Film rules. Shot boundaries follow narrative purpose and cinematic grammar (establishing, coverage, " +
    "reaction, insert, cutaway), never a provider's clip limit; most shots run 3-10 s. Give each shot a render " +
    "class by what it must carry: PREVIS or CHEAP_BROLL for inserts and atmosphere (T0/T1 only), STANDARD for " +
    "ordinary coverage, CHARACTER_CRITICAL for close acting, HERO for the few shots the film hangs on. " +
    "Lip-sync only CHARACTER_CRITICAL or HERO shots and carry most dialogue on reaction, over-the-shoulder and " +
    "cutaway coverage. Every shot after a scene's first names the shot it carries state from (continuityFrom) " +
    "and declares every intended change with a reason. If the story does not work as an animatic, fix story and " +
    "timing; a more expensive model will not save it.",
  storyboardInstructions:
    "Film boards: frame each panel by its shot size and lens, keep screen direction and eye lines across " +
    "the coverage, and keep wardrobe and props exactly as the continuity state says.",
  knowledge: {
    scope: ["narrative", "creative-direction", "composition-timing"],
    designs: ["art-direction", "wardrobe-props"],
    storyboard: ["dop-camera", "composition-timing", "performance"],
    motion: ["dop-camera", "performance", "production-failure-modes"],
    sound: ["sound", "voice-performance"],
    qa: ["production-failure-modes", "sound"],
  },
});
