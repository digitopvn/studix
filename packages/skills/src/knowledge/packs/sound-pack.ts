import type { KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

export const soundPack: KnowledgePack = {
  id: "sound",
  version: "1.0.1",
  title: "Sound design",
  summary: "Room tone, material-aware Foley, motifs, J and L cuts, silence, spatial acoustics.",
  purpose:
    "Design sound as part of the story: a room tone for every space, Foley that fits the material, motifs " +
    "that recur, cuts that lead or trail the picture, and silence used on purpose.",
  sources: [animeCreatorSource("knowledge/packs/sound.json", "AC-37")],
  phases: ["sound", "edit", "qa"],
  loadWhen: ["sound", "foley", "sfx", "music", "mix", "room tone", "silence", "motif", "audio"],
  useCases: [
    "Giving every scene a room tone (the bed under dialogue) so cuts do not drop to digital silence.",
    "Choosing Foley by material and size: boots on wet stone, a small cup on wood, cloth against armour.",
    "Leading a scene change with sound (J cut) or letting the old scene's sound trail (L cut).",
    "Placing a motif (a theme, a sound tied to a character or object) and bringing it back when the story calls it back.",
    "Dropping music and ambience to silence before a key line or hit, then bringing them back.",
  ],
  antiPatterns: [
    "Hard cuts in sound on every picture cut; the edit feels choppy.",
    "One generic footstep sample for every surface and every character.",
    "Music under every second, so nothing has room and the mix is tiring.",
    "Reverb that does not match the space (a small room with a cathedral tail).",
    "A motif used once and never returned to.",
  ],
  sections: [],
  checks: [
    {
      id: "sound.room-tone",
      kind: "hard",
      level: "scene",
      measure: "Scenes of the plan without a room tone.",
      metric: { id: "scenes-without-room-tone", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "sound.cut-kind",
      kind: "hard",
      level: "shot",
      measure:
        "Shots whose sound cut (the cut into the shot) is set to something other than J, L or straight.",
      metric: { id: "invalid-sound-cuts", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "sound.loudness",
      kind: "evidence",
      level: "video",
      measure: "Integrated loudness and true peak of the master, as measured.",
      judges: ["ai", "human"],
      evidence: ["measurement"],
      pass: "Within the delivery target.",
    },
    {
      id: "sound.audio-only",
      kind: "evidence",
      level: "scene",
      measure: "The reviewer listens without picture and writes what happens.",
      judges: ["ai", "human"],
      evidence: ["audio"],
      pass: "The scene's change is audible.",
    },
    {
      id: "sound.signoff",
      kind: "evidence",
      level: "video",
      measure: "The user approves the mix.",
      judges: ["human"],
      evidence: ["audio"],
      pass: "The user approves.",
    },
  ],
};
