import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

export const performancePack: KnowledgePack = {
  id: "performance",
  version: "1.0.1",
  title: "Performance and acting",
  summary: "Surface vs hidden emotion, micro-behaviour, gaze, pauses, posture, voice intention.",
  purpose:
    "Direct what a character shows and what they hide, so a keyframe or clip prompt carries behaviour " +
    "instead of a single emotion label.",
  sources: [animeCreatorSource("knowledge/packs/performance.json", "AC-37")],
  phases: ["storyboard", "keyframe", "motion", "sound", "qa"],
  loadWhen: [
    "acting",
    "performance",
    "emotion",
    "expression",
    "gaze",
    "subtext",
    "voice",
    "dialogue",
    "lipsync",
  ],
  useCases: [
    "Writing the surface and hidden performance per shot: smiling (surface) while afraid of being found out (hidden).",
    "Choosing one micro-behaviour per beat (a held breath, a glance away, hands that stop moving) instead of a bigger face.",
    "Giving a voice take an intention (to reassure, to stall, to provoke) before choosing pitch or pace.",
    "Keeping a character fingerprint: the habits and posture that stay the same across episodes.",
  ],
  antiPatterns: [
    "One emotion word per shot ('sad') pasted into the prompt; the face goes generic and the same in every shot.",
    "Hidden emotion that repeats the surface one, so there is no subtext to play.",
    "Gaze that wanders with no target; eyelines must point at someone or something in the set.",
    "Dialogue with no pauses; silence before a line is often where the acting is.",
    "An expression sized by default instead of by look: live-action-like looks shrink the move as the shot gets " +
      "closer, while anime looks may push a close-up reaction on purpose. Decide it per look.",
    "Emotional jumps between adjacent shots with no event in between (the trajectory breaks).",
  ],
  sections: [],
  checks: [
    {
      id: "performance.subtext-differs",
      kind: "hard",
      level: "shot",
      measure: "Shots with a hidden performance that names the same emotion as their surface performance.",
      metric: { id: "shots-hidden-equals-surface", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "performance.eyeline",
      kind: "evidence",
      level: "shot",
      measure: "The reviewer marks the gaze target in the first, middle and last frame.",
      judges: ["ai", "human"],
      evidence: ["frame-strip"],
      pass: "A target is named in all three frames.",
    },
    {
      id: "performance.trajectory",
      kind: "evidence",
      level: "scene",
      measure:
        "The reviewer lists each shot's surface emotion in order and names the event behind each change.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet", "document"],
      pass: "No emotional change happens without an event.",
    },
    {
      id: "performance.believable",
      kind: "evidence",
      level: "scene",
      measure: "The user says whether the character feels like themselves.",
      judges: ["human"],
      evidence: ["clip"],
      pass: "The user approves.",
    },
  ],
};
