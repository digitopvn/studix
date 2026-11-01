import { rm } from "node:fs/promises";
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
import type { Skill, WorkflowPack } from "../pack-registry.ts";
import {
  billedOnFailure,
  estimateMediaCents,
  generateStoredMedia,
  type StoredMediaRequest,
} from "../stored-media.ts";
import { type VoiceLine, voiceLines, voiceLineTrack, withVoiceover } from "../voice-lines.ts";
import { MOTION_GRAPHIC_TEMPLATE_VERSION, motionGraphicTemplate } from "./motion-graphic-template.ts";

export const MOTION_GRAPHIC_PACK = "motion-graphic";
export const MG_STAGES = {
  compose: "motion-graphic.compose",
  /**
   * Lays the SFX accent. It is named for the time it also voiced the graphic; the name and cache key are
   * kept so a re-voiced graphic reuses its paid accent and older jobs still resume.
   */
  accent: "motion-graphic.voiceover",
  voice: "motion-graphic.voice",
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

const voiceoverOf = (ir: VideoIR) =>
  typeof ir.metadata?.voiceover === "string" && ir.metadata.voiceover !== ""
    ? ir.metadata.voiceover
    : undefined;

/**
 * The script as one line per card, each read with its card's direction (hook, messages, call to action)
 * and the brand's tone of voice; the worker's media provider picks the speech model.
 */
function voiceLineRequests(s: StageContext): Array<{ line: VoiceLine; request: StoredMediaRequest }> {
  const ir = irOf(s);
  if (!voiceoverOf(ir)) return [];
  return voiceLines(ir).map((line, i) => ({
    line,
    request: {
      assetId: `voiceover-${i + 1}`,
      kind: "voice",
      prompt: line.text,
      params: { language: ir.language, instructions: line.instructions },
      keyPrefix: `generated/${s.job.id}/voiceover-${i + 1}`,
      maxCostCents: 0,
      reuse: {},
    },
  }));
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
      reuse: {},
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

/** The SFX accent of a graphic that has a script; none for a graphic without one (it has no voice to lead). */
async function accentRequests(s: StageContext): Promise<StoredMediaRequest[]> {
  return voiceoverOf(irOf(s)) ? [await capped(s, sfxRequest(s).request)] : [];
}

async function voiceRequests(
  s: StageContext,
): Promise<Array<{ line: VoiceLine; request: StoredMediaRequest }>> {
  return Promise.all(
    voiceLineRequests(s).map(async (v) => ({ line: v.line, request: await capped(s, v.request) })),
  );
}

/**
 * One SFX accent where the CTA card lands, for a graphic with a voice-over. No music: the voice carries the
 * graphic. The cache key is the one this stage had when it also voiced the graphic: such a cached output
 * still holds that older voice-over, which the voice stage replaces.
 */
export const motionGraphicAccentStage: StageDefinition = {
  name: MG_STAGES.accent,
  knowledge: ["sound"],
  outputSchema: IrOutput,
  cacheKey: (s) => stageCacheKey(MG_STAGES.accent, 2, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) => estimateMediaCents(s, await accentRequests(s)),
  async run(s) {
    const ir = irOf(s);
    const [request] = await accentRequests(s);
    if (!request) return { output: { ir } };
    const workDir = await stageWorkDir(s, MG_STAGES.accent);
    const sfx = await generateStoredMedia(s, MG_STAGES.accent, request);
    const accentAt = sfxRequest(s).at;
    const accentRoom = Math.max(1, ir.format.durationMs - accentAt);
    const next = {
      ...ir,
      assets: [...ir.assets.filter((a) => a.id !== sfx.asset.id), sfx.asset],
      audio: [
        ...(ir.audio ?? []).filter((t) => t.id !== "sfx-accent-track"),
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
    return {
      output: { ir: await billedOnFailure([sfx.usage], () => VideoIR.parse(next)) },
      usage: [sfx.usage],
    };
  },
};

/**
 * The voice-over of the script, one line per card, each read with its card's direction and laid where that
 * card's captions start, so the call to action is heard with the CTA card. Its own stage, so a new voice
 * (another speech model, new direction) costs only the voice.
 */
export const motionGraphicVoiceStage: StageDefinition = {
  name: MG_STAGES.voice,
  knowledge: ["voice-performance"],
  outputSchema: IrOutput,
  cacheKey: (s) => stageCacheKey(MG_STAGES.voice, 2, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) =>
    estimateMediaCents(
      s,
      (await voiceRequests(s)).map((v) => v.request),
    ),
  async run(s) {
    const ir = irOf(s);
    const planned = await voiceRequests(s);
    if (planned.length === 0) return { output: { ir } };
    const workDir = await stageWorkDir(s, MG_STAGES.voice);
    const generated = await mapBounded(
      planned,
      planned.length,
      async (v) => ({ ...v, ...(await generateStoredMedia(s, MG_STAGES.voice, v.request)) }),
      (g) => [g.usage],
    );
    await rm(workDir, { recursive: true, force: true });
    const usage = generated.map((g) => g.usage);
    const next = await billedOnFailure(usage, () =>
      VideoIR.parse(
        withVoiceover(
          ir,
          generated.map((g) => voiceLineTrack(g.line, g.asset, `${g.asset.id}-track`)),
          generated.map((g) => g.asset),
        ),
      ),
    );
    return { output: { ir: next }, usage };
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

/**
 * New project: compose -> SFX accent -> voice-over -> render -> QA -> upload. Re-render of a version:
 * render -> QA -> upload.
 */
export const motionGraphicPipeline: PackPipeline = {
  renderer: "hyperframes",
  stages: (job, e) =>
    job.fromVersion
      ? [e.plan, e.validateIr, e.render, motionGraphicQaStage, e.upload, e.finalize]
      : [
          e.brief,
          motionGraphicComposeStage,
          motionGraphicAccentStage,
          motionGraphicVoiceStage,
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
  stages: [
    motionGraphicComposeStage,
    motionGraphicAccentStage,
    motionGraphicVoiceStage,
    motionGraphicQaStage,
  ],
  pipeline: motionGraphicPipeline,
};
