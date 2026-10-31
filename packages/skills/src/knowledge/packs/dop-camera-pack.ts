// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/knowledge/packs/dop-camera.json
import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

export const dopCameraPack: KnowledgePack = {
  id: "dop-camera",
  version: "1.0.1",
  title: "DoP and camera grammar",
  summary:
    "Visual intent, shot size, lens, height, motivated moves, blocking, the 180-degree line, light ratio.",
  purpose:
    "Decide each shot from its visual intent: size, lens, height, move and light, with a reason the audience " +
    "can feel. Joins between shots use the boundary contract (locked composition, camera transition, " +
    "intentional cut).",
  sources: [animeCreatorSource("knowledge/packs/dop-camera.json", "AC-37")],
  phases: ["storyboard", "keyframe", "motion", "composition", "qa"],
  loadWhen: [
    "camera",
    "lens",
    "framing",
    "composition",
    "blocking",
    "keyframe",
    "shot",
    "angle",
    "lighting",
    "previz",
  ],
  useCases: [
    "Writing a shot as intent first ('we learn she is alone'), then the size and lens (wide, 24 mm full-frame equivalent, or a field of view) that deliver it.",
    "Choosing camera height for power: low looks up at a threat, high looks down on someone trapped, eye level is neutral.",
    "Motivating every move: the camera follows an action, reveals information or reflects a change of feeling.",
    "Keeping the 180-degree line across a dialogue, and crossing it only where the audience sees it happen: the " +
      "camera moves across, a character crosses, or a neutral on-axis shot or a re-establishing wide sits between " +
      "the two sides. A plain cut across the line is the break.",
    "Lighting with a key-to-fill ratio that fits the mood (low ratio for calm, high for threat); hard or soft light " +
      "is a separate choice, set by the size of the source.",
  ],
  antiPatterns: [
    "A slow push-in on every shot because it 'looks cinematic'; with no motivation it reads as a screensaver.",
    "Lens and size left unspecified, so the model picks a different field of view each shot.",
    "Crossing the line between two continuous shots, flipping who looks left and right.",
    "Chaining the last frame of a shot into a new composition (use a camera transition or an intentional cut instead).",
    "Light direction that changes between shots in one set with no source moving.",
    "Visual attention split: the brightest or sharpest thing in frame is not what the shot is about.",
  ],
  sections: [],
  checks: [
    {
      id: "dop-camera.lens-recorded",
      kind: "hard",
      level: "shot",
      measure: "Shots missing a camera size, or both a lens (full-frame equivalent mm) and a field of view.",
      metric: { id: "shots-without-lens", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "dop-camera.motivated-move",
      kind: "hard",
      level: "shot",
      measure: "Camera moves other than static or locked that have no recorded motivation.",
      metric: { id: "unmotivated-camera-moves", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "dop-camera.join-contract",
      kind: "hard",
      level: "shot",
      measure: "Boundary contract errors: axis or handedness flips across a continuous join.",
      metric: { id: "join-contract-errors", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "dop-camera.attention",
      kind: "evidence",
      level: "shot",
      measure: "The reviewer marks the brightest, sharpest and most saturated area of the key frame.",
      judges: ["ai", "human"],
      evidence: ["frame"],
      pass: "It is the shot's subject.",
    },
    {
      id: "dop-camera.intent-reads",
      kind: "evidence",
      level: "shot",
      measure: "The user reads the shot's intent from the picture.",
      judges: ["human"],
      evidence: ["clip"],
      pass: "The user approves.",
    },
  ],
};
