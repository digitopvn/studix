// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/knowledge/packs/narrative.json
import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

export const narrativePack: KnowledgePack = {
  id: "narrative",
  version: "1.0.0",
  title: "Narrative direction",
  summary: "Causality, want and stakes, setup and payoff, twists, arcs; what each scene changes.",
  purpose:
    "Keep every scene causally linked and changing something, and keep setups, payoffs and twists honest. " +
    "The twist ledger (setups and payoffs) lives in the story plan, never in the continuity state, which " +
    "stays the physical state that keyframe prompts read.",
  sources: [
    animeCreatorSource("knowledge/packs/narrative.json", "AC-37"),
    animeCreatorSource("references/knowledge-packs-and-film-spec.md", "AC-37"),
  ],
  phases: ["script", "storyboard", "edit", "qa"],
  loadWhen: ["story", "beat", "twist", "setup", "payoff", "arc", "script", "plot", "easter egg"],
  useCases: [
    "Writing the beat sheet before scope lock: each beat says what the character wants, what blocks it and what is different after.",
    "Planting a setup (an object, a line, a habit) and recording where it pays off, so a later cut cannot orphan it.",
    "Checking a rough cut for narrative regression: after a re-edit, does every payoff still come after its setup?",
    "Placing an easter egg: a setup whose payoff is deferred to a named later episode, so it is a promise, not noise.",
  ],
  antiPatterns: [
    "Scenes connected by 'and then' instead of 'therefore' or 'but': events follow without causing each other.",
    "A twist with no earlier evidence; the audience cannot re-read it, so it feels arbitrary.",
    "A payoff cut ahead of its setup during a re-edit (narrative regression).",
    "Stakes stated in dialogue but never shown in picture.",
    "A character arc that changes in one line of dialogue instead of across choices.",
    "Twist notes written into the continuity state, which then leak into keyframe prompts.",
  ],
  sections: [],
  checks: [
    {
      id: "narrative.scene-change",
      kind: "hard",
      level: "scene",
      measure: "Scenes of the story plan whose `change` (what is different after the scene) is empty.",
      metric: { id: "scenes-without-change", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "narrative.payoff-after-setup",
      kind: "hard",
      level: "video",
      measure:
        "Payoffs that name a missing setup or come before their setup in cut order, plus setups with neither a " +
        "payoff nor a deferred payoff.",
      metric: { id: "payoff-setup-failures", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "narrative.causal-chain",
      kind: "evidence",
      level: "video",
      measure: "The reviewer writes the scene chain as 'X, therefore/but Y' and marks each 'and then'.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass: "No 'and then' link is left unexplained.",
    },
    {
      id: "narrative.change-reads",
      kind: "evidence",
      level: "scene",
      measure: "The user watches the scene and says what changed.",
      judges: ["human"],
      evidence: ["clip"],
      pass: "What the user names matches the scene's recorded `change`.",
    },
  ],
};
