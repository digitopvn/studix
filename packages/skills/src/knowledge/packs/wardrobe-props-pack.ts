// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/knowledge/packs/wardrobe-props.json
import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

export const wardrobePropsPack: KnowledgePack = {
  id: "wardrobe-props",
  version: "1.0.0",
  title: "Wardrobe, props and environment",
  summary: "Wardrobe states, materials, wear and damage, props and set dressing, events that change them.",
  purpose:
    "Track what characters wear and carry, and how it changes, as state driven by events, so a jacket does " +
    "not dry, tear or vanish between shots without a reason.",
  sources: [animeCreatorSource("knowledge/packs/wardrobe-props.json", "AC-37")],
  phases: ["design", "storyboard", "keyframe", "qa"],
  loadWhen: ["wardrobe", "costume", "outfit", "prop", "set dressing", "material", "damage", "wet"],
  useCases: [
    "Naming wardrobe looks per character in the character bible (look ids) and using them per shot.",
    "Recording an event when a look changes: soaked in the rain, sleeve torn in the fight, coat taken off indoors.",
    "Choosing materials that move right: heavy wool swings slowly, silk flows, leather creases and holds.",
    "Dressing a set with practical objects at a known scale (a door handle, a cup) so character size stays readable.",
    "Labelling cultural or historical clothing by source and checking it before use, rather than mixing eras at random.",
  ],
  antiPatterns: [
    "A look that changes between adjacent shots with no event (dry hair one shot after the rain).",
    "Props that appear in a hand with no shot of picking them up, or switch hands across a continuous join.",
    "Damage that heals between scenes without a time skip or a repair.",
    "Fabric that moves the same way in wind, running and stillness.",
    "Cultural dress used as decoration without a source label.",
  ],
  sections: [],
  checks: [
    {
      id: "wardrobe-props.change-has-event",
      kind: "hard",
      level: "shot",
      measure:
        "Shots where a character's wardrobe look differs from their previous shot and the shot records no event.",
      metric: { id: "wardrobe-changes-without-event", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "wardrobe-props.continuity",
      kind: "hard",
      level: "shot",
      measure: "Definite continuity breaks in props or costume across each cut.",
      metric: { id: "continuity-definite-breaks", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "wardrobe-props.material-motion",
      kind: "evidence",
      level: "shot",
      measure: "The reviewer names the fabric and how it moves in a frame strip.",
      judges: ["ai", "human"],
      evidence: ["frame-strip"],
      pass: "The motion fits the material and the action.",
    },
    {
      id: "wardrobe-props.source-label",
      kind: "evidence",
      level: "asset",
      measure: "Cultural or historical dress in a sheet has a source note.",
      judges: ["ai", "human"],
      evidence: ["document"],
      pass: "Every such sheet has one.",
    },
  ],
};
