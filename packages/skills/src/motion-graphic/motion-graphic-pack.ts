import { rm } from "node:fs/promises";
import { AssetRef, CreativeBrief, exportJsonSchemas, VideoIR } from "@studix/video-ir";
import {
  irOf,
  type PackPipeline,
  RenderOutput,
  read,
  requireService,
  type StageContext,
  type StageDefinition,
  stageCacheKey,
  stageWorkDir,
} from "@studix/workflow";
import { z } from "zod";
import { VO_PAD_MS } from "../marketing-video/marketing-script.ts";
import type { Skill, WorkflowPack } from "../pack-registry.ts";
import {
  billedOnFailure,
  estimateMediaCents,
  generateStoredMedia,
  type StoredMediaRequest,
} from "../stored-media.ts";
import { MOTION_GRAPHIC_TEMPLATE_VERSION, motionGraphicTemplate } from "./motion-graphic-template.ts";

export const MOTION_GRAPHIC_PACK = "motion-graphic";
export const MG_STAGES = {
  compose: "motion-graphic.compose",
  voiceover: "motion-graphic.voiceover",
  qa: "motion-graphic.qa",
} as const;

let creativeBriefSchema: Record<string, unknown> | undefined;
export const motionGraphicSkill: Skill = {
  id: MOTION_GRAPHIC_PACK,
  title: "Motion graphic",
  description:
    "HTML/GSAP-first motion graphic (6–60s, default 15s 9:16): kinetic title, message and CTA cards in a " +
    "style profile matched to the brief, a generated voice-over and burned captions. No image-to-video.",
  version: 1,
  get inputSchema() {
    creativeBriefSchema ??= exportJsonSchemas()["creative-brief"];
    return structuredClone(creativeBriefSchema);
  },
  output: "video-ir",
  run: (input, options) => motionGraphicTemplate(input, options),
};

const ComposeInput = z.object({
  payload: z.object({ assets: z.array(AssetRef).optional() }),
  outputs: z.object({ brief: z.object({ brief: CreativeBrief }) }),
});
type ComposeInput = z.infer<typeof ComposeInput>;
const IrOutput = z.object({ ir: VideoIR });

/** Brief -> kinetic IR in the resolved style profile, with its voice-over script and captions. Free. */
export const motionGraphicComposeStage: StageDefinition = {
  name: MG_STAGES.compose,
  knowledge: ["motion-design", "motion-craft", "composition-timing"],
  inputSchema: ComposeInput,
  outputSchema: IrOutput,
  cacheKey: (s) => {
    const input = s.input as ComposeInput;
    return stageCacheKey(MG_STAGES.compose, MOTION_GRAPHIC_TEMPLATE_VERSION, {
      brief: input.outputs.brief.brief,
      assets: input.payload.assets ?? [],
    });
  },
  async run(s) {
    const input = s.input as ComposeInput;
    return {
      output: { ir: motionGraphicTemplate(input.outputs.brief.brief, { assets: input.payload.assets }) },
    };
  },
};

function voiceRequest(s: StageContext): StoredMediaRequest | undefined {
  const ir = irOf(s);
  const text = typeof ir.metadata?.voiceover === "string" ? ir.metadata.voiceover : undefined;
  if (!text) return undefined;
  return {
    assetId: "voiceover",
    kind: "voice",
    prompt: text,
    params: { language: ir.language },
    keyPrefix: `generated/${s.job.id}/voiceover`,
    maxCostCents: 0,
  };
}

async function capped(s: StageContext, r: StoredMediaRequest): Promise<StoredMediaRequest> {
  const estimate = await requireService(s, "media").estimateCostCents({
    kind: r.kind,
    prompt: r.prompt,
    maxCostCents: 1_000_000,
    ...(r.params ? { params: r.params } : {}),
  });
  return { ...r, maxCostCents: Math.max(5, Math.ceil(estimate * 2)) };
}

/** The voice-over of the script, generated with the worker's speech model and laid under the captions. */
export const motionGraphicVoiceoverStage: StageDefinition = {
  name: MG_STAGES.voiceover,
  knowledge: ["voice-performance", "sound"],
  outputSchema: IrOutput,
  cacheKey: (s) =>
    stageCacheKey(MG_STAGES.voiceover, 1, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) => {
    const r = voiceRequest(s);
    return r ? estimateMediaCents(s, [await capped(s, r)]) : 0;
  },
  async run(s) {
    const ir = irOf(s);
    const planned = voiceRequest(s);
    if (!planned) return { output: { ir } };
    const workDir = await stageWorkDir(s, MG_STAGES.voiceover);
    const media = await generateStoredMedia(s, MG_STAGES.voiceover, await capped(s, planned));
    const room = ir.format.durationMs - VO_PAD_MS;
    const next = {
      ...ir,
      assets: [...ir.assets.filter((a) => a.id !== media.asset.id), media.asset],
      audio: [
        ...(ir.audio ?? []).filter((t) => t.id !== "voiceover-track"),
        {
          id: "voiceover-track",
          kind: "voiceover" as const,
          assetId: media.asset.id,
          startMs: VO_PAD_MS,
          durationMs: Math.max(1, Math.min(room, media.asset.durationMs ?? room)),
          volume: 1,
        },
      ],
    };
    await rm(workDir, { recursive: true, force: true });
    return {
      output: { ir: await billedOnFailure([media.usage], () => VideoIR.parse(next)) },
      usage: [media.usage],
    };
  },
};

/** The blocking QA gate on the render; a graphic with a voice-over must also pass the audio checks. */
export const motionGraphicQaStage: StageDefinition = {
  name: MG_STAGES.qa,
  knowledge: ["production-failure-modes"],
  async run(s) {
    const qa = requireService(s, "qa");
    const ir = irOf(s);
    const rendered = read(RenderOutput, s.outputs.render, "render checkpoint");
    const report = await qa.assertPasses(
      rendered.filePath,
      {
        durationMs: ir.format.durationMs,
        fps: ir.format.fps,
        requireAudio: (ir.audio ?? []).length > 0,
        knowledge: motionGraphicQaStage.knowledge,
      },
      s.signal,
    );
    return { output: { pass: true, report } };
  },
};

/** New project: compose -> voice-over -> render -> QA -> upload. Re-render of a version: render -> QA -> upload. */
export const motionGraphicPipeline: PackPipeline = {
  renderer: "hyperframes",
  stages: (job, e) =>
    job.fromVersion
      ? [e.plan, e.validateIr, e.render, motionGraphicQaStage, e.upload, e.finalize]
      : [
          e.brief,
          motionGraphicComposeStage,
          motionGraphicVoiceoverStage,
          e.validateIr,
          e.render,
          motionGraphicQaStage,
          e.upload,
          e.finalize,
        ],
};

export const motionGraphicPack: WorkflowPack = {
  id: MOTION_GRAPHIC_PACK,
  title: "Motion graphic",
  version: 1,
  templates: [motionGraphicSkill],
  stages: [motionGraphicComposeStage, motionGraphicVoiceoverStage, motionGraphicQaStage],
  pipeline: motionGraphicPipeline,
};
