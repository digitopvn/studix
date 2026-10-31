// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/knowledge/packs/physics-lite.json
import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

export const physicsLitePack: KnowledgePack = {
  id: "physics-lite",
  version: "1.0.0",
  title: "Physics-lite",
  summary:
    "Weight, contact, collisions, fire, water, smoke and light responses; justified stylised exceptions.",
  purpose:
    "Give action and effects believable weight, contact and response, and write down every stylised " +
    "exception with its reason, so stylised physics is a choice and not a model error.",
  sources: [animeCreatorSource("knowledge/packs/physics-lite.json", "AC-37")],
  phases: ["storyboard", "keyframe", "motion", "composition", "qa"],
  loadWhen: ["physics", "fight", "action", "impact", "fire", "water", "smoke", "weather", "fx", "collision"],
  useCases: [
    "Writing a hit as anticipation, contact, follow-through and recovery, with the heavier body moving less.",
    "Giving effects a response: fire lights nearby faces, rain darkens fabric and makes ground reflective, smoke drifts with the wind.",
    "Recording a stylised exception per shot (a hang time in a jump, an impossible speed line) with the reason (a power reveal).",
    "Checking contact: feet on the ground plane, hands on the object they hold, no hovering or sinking.",
  ],
  antiPatterns: [
    "Impacts with no anticipation or recoil; the hit has no weight.",
    "Light effects (fire, magic, screens) that do not light anything around them.",
    "Water and smoke that ignore the wind direction set in the same scene.",
    "Feet sliding on the ground during a walk cycle, or a held object drifting from the hand.",
    "Breaking physics in every shot, so the one exception that should matter does not stand out.",
  ],
  sections: [],
  checks: [
    {
      id: "physics-lite.exception-justified",
      kind: "hard",
      level: "shot",
      measure: "Physics entries that declare a stylised exception without a reason.",
      metric: { id: "physics-exceptions-without-reason", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "physics-lite.action-plan",
      kind: "hard",
      level: "shot",
      measure: "Action plan errors: axis, props, contact and flash rate.",
      metric: { id: "action-plan-errors", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "physics-lite.contact",
      kind: "evidence",
      level: "shot",
      measure: "The reviewer checks a frame strip for feet and hand contact.",
      judges: ["ai", "human"],
      evidence: ["frame-strip"],
      pass: "No sliding, hovering or drifting held objects.",
    },
    {
      id: "physics-lite.light-response",
      kind: "evidence",
      level: "shot",
      measure: "For a light-emitting effect, the reviewer shows the lit surfaces around it.",
      judges: ["ai", "human"],
      evidence: ["frame"],
      pass: "At least one nearby surface responds.",
    },
  ],
};
