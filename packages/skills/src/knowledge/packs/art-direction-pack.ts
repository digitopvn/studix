// Ported from zuey-workspace@10719856:.agents/skills/anime-creator/knowledge/packs/art-direction.json
import type { KnowledgeEntry, KnowledgePack } from "../knowledge-pack-schema.ts";
import { animeCreatorSource } from "../knowledge-sources.ts";

interface Look {
  id: string;
  title: string;
  tokens: string;
  palette: string;
  shapeLineMaterialLight: string;
  consistencyRisk: string;
  cameraMotionFit: string;
  cost: string;
  legal: string;
  avoidWhen: string;
}

function look(l: Look): KnowledgeEntry {
  const { id, title, tokens, ...fields } = l;
  return { id, title, text: `Style tokens: ${tokens}.`, fields: { tokens, ...fields } };
}

export const artDirectionPack: KnowledgePack = {
  id: "art-direction",
  version: "1.0.1",
  title: "Art direction registry",
  summary: "A registry of looks with tokens, palette, risks, camera fit and when not to use them.",
  purpose:
    "Pick a look from a registry of named styles, each with its tokens, palette, shape, line, material and " +
    "light, its consistency risk, its fit with camera and motion, its cost, its legal terms and when not to " +
    "use it. Styles are described by their visual traits, never by the name of a living artist or a studio.",
  sources: [animeCreatorSource("knowledge/packs/art-direction.json", "AC-37")],
  phases: ["design", "keyframe", "grade", "qa"],
  loadWhen: ["style", "look", "palette", "art direction", "sheet", "design", "grade", "render style"],
  useCases: [
    "Choosing the series look at scope lock and recording it as the plan's look, with the tokens reused in every sheet and keyframe prompt.",
    "Checking whether a look survives the shot list: long camera moves, fast action, many characters.",
    "Mixing looks on purpose (a flashback in ink wash) and recording that as a scene-level exception.",
    "Estimating the cost of a look before scope lock: some need more retakes or GL work to stay consistent.",
  ],
  antiPatterns: [
    "Naming a living artist or a studio in a prompt to borrow their style.",
    "A look chosen from one beautiful still that breaks down in motion (texture boiling, line flicker).",
    "Palette drift: each sheet and keyframe invents its own colours instead of reusing the tokens.",
    "Mixing looks shot to shot with no story reason.",
    "Choosing a high-detail look for an action-heavy episode on a small budget.",
  ],
  sections: [
    {
      id: "looks",
      title: "Look registry",
      entries: [
        look({
          id: "cel",
          title: "Cel",
          tokens: "flat cel shading, clean ink lines, two-tone shadows",
          palette: "saturated, limited per character",
          shapeLineMaterialLight:
            "clear silhouettes; uniform line weight; materials by colour, not texture; hard-edged light",
          consistencyRisk: "low",
          cameraMotionFit: "pans, trucks and fast action; orbits and rotating 3D moves are its weak spot",
          cost: "lowest retakes",
          legal: "generic look",
          avoidWhen: "the story needs painterly texture or photographic depth",
        }),
        look({
          id: "retro-anime",
          title: "Retro TV anime",
          tokens: "1980s-90s TV anime, film grain, soft halation, painted backgrounds",
          palette: "muted, warm, slightly faded",
          shapeLineMaterialLight: "thicker lines, airbrushed highlights, painted skies; bloom on lights",
          consistencyRisk: "medium (grain and halation must match in grade)",
          cameraMotionFit: "pans and holds; limited 3D moves",
          cost: "grade work per shot",
          legal: "generic period look",
          avoidWhen: "a modern, crisp product feel is required",
        }),
        look({
          id: "ink-wash",
          title: "Ink wash",
          tokens: "ink wash, brush strokes, wet edges, paper texture",
          palette: "monochrome ink with one accent colour",
          shapeLineMaterialLight: "shape by brush; variable line; negative space; light by absence of ink",
          consistencyRisk: "high (strokes boil between frames)",
          cameraMotionFit: "slow moves, holds, transitions",
          cost: "more retakes; a GL paper overlay helps",
          legal: "traditional technique; label the cultural source",
          avoidWhen: "dense action or many characters",
        }),
        look({
          id: "watercolor",
          title: "Watercolour",
          tokens: "watercolour washes, soft edges, granulation, paper white",
          palette: "light, transparent, pastel",
          shapeLineMaterialLight: "soft shapes; little line; light from paper white",
          consistencyRisk: "high (washes shift frame to frame)",
          cameraMotionFit: "slow; holds",
          cost: "more retakes",
          legal: "generic technique",
          avoidWhen: "fast cutting, dark scenes or heavy contrast",
        }),
        look({
          id: "gouache",
          title: "Gouache",
          tokens: "opaque gouache, matte flat colour, visible brush texture",
          palette: "rich, matte, mid-saturation",
          shapeLineMaterialLight: "bold shapes; few lines; flat light planes",
          consistencyRisk: "medium",
          cameraMotionFit: "most moves; texture should ride the plate",
          cost: "medium",
          legal: "generic technique",
          avoidWhen: "glossy or metallic materials carry the story",
        }),
        look({
          id: "graphic-novel-noir",
          title: "Graphic novel noir",
          tokens: "high-contrast black and white, heavy shadow shapes, halftone",
          palette: "black, white, one spot colour",
          shapeLineMaterialLight: "shadow as shape; hard key light; strong silhouettes",
          consistencyRisk: "medium (shadow shapes must stay motivated)",
          cameraMotionFit: "static and dutch angles; slow push",
          cost: "low to medium",
          legal: "generic genre look",
          avoidWhen: "light comedy or colour-coded storytelling",
        }),
        look({
          id: "toon-shaded-3d",
          title: "Toon-shaded 3D",
          tokens: "toon-shaded 3D, outline pass, stepped shading",
          palette: "saturated, ramp-based",
          shapeLineMaterialLight: "3D volumes with 2-3 shading steps; outlines from geometry",
          consistencyRisk: "low once the model exists",
          cameraMotionFit: "full 3D moves and orbits",
          cost: "high setup (models, rigs), low per shot",
          legal: "own models only",
          avoidWhen: "there is no 3D pipeline or a hand-drawn feel is essential",
        }),
        look({
          id: "mixed-media",
          title: "Mixed media",
          tokens: "cut paper, collage, photo texture over drawn characters",
          palette: "per element; one unifying grade",
          shapeLineMaterialLight: "layers with visible edges; light baked per element",
          consistencyRisk: "high (layers must stay registered)",
          cameraMotionFit: "lateral moves; flat cel moves (no layer-split parallax)",
          cost: "high compositing",
          legal: "every photo or texture needs a licence",
          avoidWhen: "sources cannot be licensed or the shot list is long",
        }),
      ],
    },
  ],
  checks: [
    {
      id: "art-direction.look-in-registry",
      kind: "hard",
      level: "video",
      measure: "The plan's look is set and is an id of the look registry (1 when it is not).",
      metric: { id: "look-not-in-registry", unit: "count" },
      threshold: { op: "==", value: 0 },
    },
    {
      id: "art-direction.palette-holds",
      kind: "evidence",
      level: "video",
      measure: "The reviewer compares a contact sheet of one frame per scene against the look tokens.",
      judges: ["ai", "human"],
      evidence: ["contact-sheet"],
      pass: "No scene drifts off-palette without a recorded exception.",
    },
    {
      id: "art-direction.no-living-artist",
      kind: "evidence",
      level: "asset",
      measure: "The reviewer searches sheet and keyframe prompts for artist or studio names.",
      judges: ["ai", "human"],
      evidence: ["prompt"],
      pass: "None found.",
    },
    {
      id: "art-direction.look-approved",
      kind: "evidence",
      level: "video",
      measure: "The user approves the look at scope lock or design approval.",
      judges: ["human"],
      evidence: ["contact-sheet"],
      pass: "The user approves.",
    },
  ],
};
