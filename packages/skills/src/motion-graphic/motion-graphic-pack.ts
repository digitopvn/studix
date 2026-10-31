import { rm } from "node:fs/promises";
import { StudixError } from "@studix/shared";
import { AssetRef, CreativeBrief, exportJsonSchemas, VideoIR } from "@studix/video-ir";
import {
  irOf,
  mapBounded,
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
    "style profile matched to the brief, a generated voice-over with one SFX accent on the CTA card and " +
    "burned captions. No image-to-video and no music.",
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

const SFX_MS = 1500;
/** Where the accent lands when the IR has no CTA scene: this long before the end. */
const SFX_TAIL_MS = 3000;

/** One soft accent where the CTA card lands; the voice-over stays the lead. */
function sfxRequest(s: StageContext): { at: number; request: StoredMediaRequest } {
  const ir = irOf(s);
  const ctaIndex = ir.scenes.findIndex((scene) => scene.id === "cta");
  const at =
    ctaIndex === -1
      ? Math.max(0, ir.format.durationMs - SFX_TAIL_MS)
      : ir.scenes.slice(0, ctaIndex).reduce((ms, scene) => ms + scene.durationMs, 0);
  return {
    at,
    request: {
      assetId: "sfx-accent",
      kind: "sfx",
      prompt: "Soft airy whoosh into a gentle chime, clean, short",
      params: { durationMs: SFX_MS },
      keyPrefix: `generated/${s.job.id}/sfx-accent`,
      maxCostCents: 0,
    },
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

/** The voice-over and the SFX accent of a graphic that has a script; none for a graphic without one. */
async function audioRequests(s: StageContext): Promise<StoredMediaRequest[]> {
  const voice = voiceRequest(s);
  if (!voice) return [];
  return [await capped(s, voice), await capped(s, sfxRequest(s).request)];
}

/**
 * The voice-over of the script, generated with the worker's speech model and laid under the captions, and
 * one SFX accent where the CTA card lands. No music: the voice carries the graphic.
 */
export const motionGraphicVoiceoverStage: StageDefinition = {
  name: MG_STAGES.voiceover,
  knowledge: ["voice-performance", "sound"],
  outputSchema: IrOutput,
  cacheKey: (s) =>
    stageCacheKey(MG_STAGES.voiceover, 2, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) => estimateMediaCents(s, await audioRequests(s)),
  async run(s) {
    const ir = irOf(s);
    const requests = await audioRequests(s);
    if (requests.length === 0) return { output: { ir } };
    const workDir = await stageWorkDir(s, MG_STAGES.voiceover);
    const [voice, sfx] = await mapBounded(
      requests,
      requests.length,
      (r) => generateStoredMedia(s, MG_STAGES.voiceover, r),
      (m) => [m.usage],
    );
    if (!voice || !sfx) throw new StudixError("INTERNAL", "motion-graphic audio returned too few results");
    const room = ir.format.durationMs - VO_PAD_MS;
    const accentAt = sfxRequest(s).at;
    const accentRoom = Math.max(1, ir.format.durationMs - accentAt);
    const usage = [voice.usage, sfx.usage];
    const ids = new Set([voice.asset.id, sfx.asset.id]);
    const next = {
      ...ir,
      assets: [...ir.assets.filter((a) => !ids.has(a.id)), voice.asset, sfx.asset],
      audio: [
        ...(ir.audio ?? []).filter((t) => t.id !== "voiceover-track" && t.id !== "sfx-accent-track"),
        {
          id: "voiceover-track",
          kind: "voiceover" as const,
          assetId: voice.asset.id,
          startMs: VO_PAD_MS,
          durationMs: Math.max(1, Math.min(room, voice.asset.durationMs ?? room)),
          volume: 1,
        },
        {
          id: "sfx-accent-track",
          kind: "sfx" as const,
          assetId: sfx.asset.id,
          startMs: accentAt,
          durationMs: Math.min(accentRoom, sfx.asset.durationMs ?? SFX_MS),
          volume: 0.6,
        },
      ],
    };
    await rm(workDir, { recursive: true, force: true });
    return { output: { ir: await billedOnFailure(usage, () => VideoIR.parse(next)) }, usage };
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
