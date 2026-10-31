import type { KnowledgeEntry, KnowledgePack } from "../knowledge-pack-schema.ts";
import { agentkitSource } from "../knowledge-sources.ts";
import { SIGNATURE_MOTION_STYLES, type SignatureMotionStyle } from "./signature-motion-styles-data.ts";

const STYLES = "kits/marketing/skills/ak-motion-video/references/styles";

/** Studix ids that differ from the source file name: the source names came from design-system products. */
const RENAMED_FROM: Readonly<Record<string, string>> = {
  "expressive-tonal-ui": "expressive-material",
  "layered-productivity": "fluent-productivity",
};

const list = (items: readonly string[]) => items.join("; ");

/** A profile as a registry row: every dimension becomes a field so stages and search can read it. */
function styleEntry(s: SignatureMotionStyle): KnowledgeEntry {
  return {
    id: s.id,
    title: s.name,
    text: `${s.summary} ${s.character}`,
    fields: {
      aliases: s.aliases.join(", "),
      energy: String(s.energy),
      bestFor: s.bestFor.join(", "),
      paletteMode: s.palette.mode,
      paletteColors: Object.entries(s.palette.colors)
        .map(([role, hex]) => `${role} ${hex}`)
        .join(", "),
      paletteRule: s.palette.rule,
      typography: list(s.typography),
      layout: list(s.layout),
      material: list(s.material),
      texture: list(s.texture),
      camera: list(s.camera),
      transitions: list(s.transitions),
      bpm: `${s.bpm[0]}-${s.bpm[1]}`,
      rhythm: s.rhythm,
      beatResponse: list(s.beatResponse),
      uiChoreography: list(s.uiChoreography),
      diagrams: list(s.diagrams),
      characterMotion: list(s.characterMotion),
      captions: list(s.captions),
      sound: list(s.sound),
      preferScenes: s.preferScenes.join(", "),
      avoidScenes: s.avoidScenes.join(", "),
      signatureMoves: list(s.signatureMoves),
      strengths: list(s.strengths),
      constraints: list(s.constraints),
      avoid: list(s.avoid),
      pairsWellWith: s.pairsWellWith.join(", "),
    },
    tags: ["motion-style", ...s.aliases],
  };
}

export const signatureMotionStylesPack: KnowledgePack = {
  id: "signature-motion-styles",
  version: "1.0.0",
  title: "Signature motion styles",
  summary:
    "Forty complete motion-design styles (product keynotes, developer tools, sport hype, playful UI, documentary), " +
    "each named by its look.",
  purpose:
    "Give the brief and design stages a ready motion language: palette, type, layout, material, texture, camera, " +
    "transitions, pacing, beat response, UI choreography, diagrams, character motion, captions and sound, plus the " +
    "constraints that keep it coherent. A video takes one profile as its base and may borrow single dimensions from " +
    "others for named scenes. Profiles describe a look; they never license a brand's assets.",
  sources: [
    agentkitSource(`${STYLES}/index.yaml`, "MV-14"),
    agentkitSource("kits/marketing/skills/ak-motion-video/references/style-system.md", "MV-14"),
    ...SIGNATURE_MOTION_STYLES.map(({ id }) =>
      agentkitSource(`${STYLES}/profiles/${RENAMED_FROM[id] ?? id}.yaml`, "MV-14"),
    ),
  ],
  phases: ["brief", "design", "motion", "composition", "sound", "edit"],
  loadWhen: [
    "motion style",
    "style profile",
    "look and feel",
    "product launch video",
    "keynote",
    "ui demo",
    "explainer",
    "promo",
    "brand film",
    "motion language",
  ],
  useCases: [
    'Resolving a request such as "a premium product film" or "a developer-tool launch" to one base profile.',
    "Mixing styles: a base profile with one dimension (UI choreography, diagrams, a finale's pacing) borrowed per scene.",
    "Turning a profile into tokens and timing: colour roles, type scale, transition vocabulary and the BPM band.",
    "Reviewing frames against the base profile's constraints and avoid list.",
  ],
  antiPatterns: [
    "Naming a brand to pick a style, or copying its logo, marks, sonic logo, mascot, typeface, product imagery or slogan.",
    "Using a brand's exact colour values instead of the profile's own palette.",
    "Layering whole styles on top of each other instead of borrowing named dimensions for named scenes.",
    "More than one base and four layers, or more than two transition languages in one video.",
    "Breaking a base constraint because a borrowed dimension asked for it.",
  ],
  sections: [
    {
      id: "using-styles",
      title: "Using the profiles",
      entries: [
        {
          id: "base-and-layers",
          title: "One base, borrowed dimensions",
          text:
            "Pick one base profile; it supplies every dimension for every scene. A layer borrows only the dimensions " +
            "it names, for the scenes it names (by id or scene type); when two layers touch the same dimension of the " +
            "same scene, the later one wins. A layer's palette adds accents on top of the base background and ink " +
            "unless it asks for the full palette. Use at most one base and four layers.",
          tags: ["rule"],
        },
        {
          id: "constraints-bind",
          title: "Base constraints bind everywhere",
          text:
            "The base profile's constraints hold in every scene; a layer's constraints hold only in its scenes. When " +
            "a borrowed value breaks a base constraint, keep the base value and note it. The composition contract, " +
            "determinism, caption legibility, mix targets and renderer limits are never overridden by any style.",
          tags: ["rule"],
        },
        {
          id: "no-brand-assets",
          title: "A look, never a brand",
          text:
            "Ids, names and aliases describe the motion language, not who made it famous. Output borrows no logos, " +
            "marks, sonic logos, mascots, trademarked typefaces, product imagery, slogans or exact brand colour " +
            "values, and never implies endorsement. Profiles name only freely licensed web fonts.",
          tags: ["rule"],
        },
        {
          id: "resolve-or-bake-off",
          title: "Resolve the request, or run a bake-off",
          text:
            "Match the request to an id, then to aliases, then to summaries and best-for tags, and say which profile " +
            "was chosen and why. If nothing matches or two profiles tie, build the same hook scene in three or four " +
            "candidate profiles and let the user pick from the stills.",
          tags: ["rule"],
        },
      ],
    },
    {
      id: "styles",
      title: "Style profiles",
      entries: SIGNATURE_MOTION_STYLES.map(styleEntry),
    },
  ],
  checks: [
    {
      id: "signature-motion-styles.no-brand-assets",
      kind: "evidence",
      level: "video",
      measure: "Frames, audio and on-screen text of the piece against the no-brand-assets rule.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet", "audio", "document"],
      pass:
        "No logo, mark, sonic logo, mascot, trademarked typeface, product imagery, slogan or exact brand colour of " +
        "a third party appears, and nothing implies endorsement.",
    },
    {
      id: "signature-motion-styles.base-constraints",
      kind: "evidence",
      level: "scene",
      measure: "Each scene's frames against the base profile's constraints and avoid list.",
      judges: ["ai", "human"],
      evidence: ["frame-strip", "document"],
      pass:
        "Every scene keeps the base constraints, and any value a layer changed is noted with the reason it was " +
        "kept or dropped.",
    },
  ],
};
