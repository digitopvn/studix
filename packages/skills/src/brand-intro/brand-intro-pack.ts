import { AssetRef, CreativeBrief, exportJsonSchemas, VideoIR } from "@studix/video-ir";
import { type StageDefinition, stageCacheKey } from "@studix/workflow";
import { z } from "zod";
import type { Skill, WorkflowPack } from "../pack-registry.ts";
import { BRAND_INTRO_TEMPLATE_VERSION, brandIntroTemplate } from "./brand-intro-template.ts";

let creativeBriefSchema: Record<string, unknown> | undefined;
function briefSchema(): Record<string, unknown> {
  creativeBriefSchema ??= exportJsonSchemas()["creative-brief"];
  return creativeBriefSchema;
}

export const brandIntroSkill: Skill = {
  id: "brand-intro",
  title: "Brand intro",
  description:
    "Deterministic 6–15s brand introduction: title card, two or three key messages and a call-to-action " +
    "outro in the brief's aspect ratio and brand colors. Vietnamese copy is kept intact.",
  version: 1,
  get inputSchema() {
    // A copy per read so a caller mutating its schema cannot change what other callers see.
    return structuredClone(briefSchema());
  },
  output: "video-ir",
  run: brandIntroTemplate,
};

export const BRAND_INTRO_COMPOSE_STAGE = "brand-intro.compose";

const ComposeInput = z.object({
  payload: z.object({ brief: CreativeBrief, assets: z.array(AssetRef).optional() }),
});
type ComposeInput = z.infer<typeof ComposeInput>;

/**
 * Brief -> VideoIR with the brand-intro template. Pure and free, keyed by the template version and the
 * brief, so an unchanged brief is composed once per workspace.
 */
export const brandIntroComposeStage: StageDefinition = {
  name: BRAND_INTRO_COMPOSE_STAGE,
  inputSchema: ComposeInput,
  outputSchema: z.object({ ir: VideoIR }),
  cacheKey: (s) => stageCacheKey(BRAND_INTRO_COMPOSE_STAGE, BRAND_INTRO_TEMPLATE_VERSION, s.input),
  async run(s) {
    const { brief, assets } = (s.input as ComposeInput).payload;
    return { output: { ir: brandIntroTemplate(brief, { assets }) } };
  },
};

export const brandIntroPack: WorkflowPack = {
  id: "brand-intro",
  title: "Brand intro",
  version: 1,
  templates: [brandIntroSkill],
  stages: [brandIntroComposeStage],
};
