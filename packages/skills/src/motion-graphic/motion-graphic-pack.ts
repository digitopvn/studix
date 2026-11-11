import { rm } from "node:fs/promises";
import { StudixError, toStudixError } from "@studix/shared";
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
  type StoredMedia,
  type StoredMediaRequest,
} from "../stored-media.ts";
import { truncateText } from "../vietnamese-safe-text.ts";
import { type VoiceLine, voiceLines, withVoiceover } from "../voice-lines.ts";
import { generateVoiceTake, VOICE_FIT_SCOPE } from "../voice-takes.ts";
import {
  MG_STORYBOARD_STAGE,
  MotionStoryboardOutput,
  motionGraphicStoryboardStage,
} from "./motion-graphic-storyboard.ts";
import { MOTION_GRAPHIC_TEMPLATE_VERSION, motionGraphicTemplate } from "./motion-graphic-template.ts";

export const MOTION_GRAPHIC_PACK = "motion-graphic";
export const MG_STAGES = {
  storyboard: MG_STORYBOARD_STAGE,
  compose: "motion-graphic.compose",
  /**
   * Lays the SFX accent. It is named for the time it also voiced the graphic; the name and cache key are
   * kept so a re-voiced graphic reuses its paid accent and older jobs still resume.
   */
  accent: "motion-graphic.voiceover",
  voice: "motion-graphic.voice",
  music: "motion-graphic.music",
  qa: "motion-graphic.qa",
} as const;

let creativeBriefSchema: Record<string, unknown> | undefined;
export const motionGraphicSkill: Skill = {
  id: MOTION_GRAPHIC_PACK,
  title: "Motion graphic",
  description:
    "HTML/GSAP-first motion graphic (6–60s, default 15s 9:16): the workspace's agent writes the script and " +
    "storyboard from the motion knowledge packs (style profile, beats, entrances, optional music bed), " +
    "falling back to brief-derived kinetic cards without an agent (never when the job names its `agent`); a " +
    "generated voice-over with burned captions and one SFX accent on the CTA card; the accent and music bed " +
    "are skipped with a warning when their provider is not set. Needs a speech provider only with a voice-over: `brief.voiceover: false` " +
    "makes a voiceless graphic (on-screen text only). No image-to-video.",
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
  outputs: z.object({
    brief: z.object({ brief: CreativeBrief }),
    // Optional: jobs checkpointed before the storyboard stage existed resume without it.
    [MG_STORYBOARD_STAGE]: MotionStoryboardOutput.optional(),
  }),
});
type ComposeInput = z.infer<typeof ComposeInput>;
const IrOutput = z.object({ ir: VideoIR });

/** Brief, and the agent's storyboard when there is one -> kinetic IR with its voice-over and captions. Free. */
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
      storyboard: input.outputs[MG_STORYBOARD_STAGE]?.storyboard ?? null,
    });
  },
  async run(s) {
    const input = s.input as ComposeInput;
    return {
      output: {
        ir: motionGraphicTemplate(input.outputs.brief.brief, {
          assets: input.payload.assets,
          storyboard: input.outputs[MG_STORYBOARD_STAGE]?.storyboard,
        }),
      },
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
      reuse: { scope: VOICE_FIT_SCOPE },
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

/** A media call that could not be made at all (no provider, no key, no price); nothing was spent on it. */
const unavailable = (err: unknown) => err instanceof StudixError && err.code === "UNAVAILABLE";

/** The SFX accent of a graphic that has a script; none for a graphic without one (it has no voice to lead). */
async function accentRequests(s: StageContext): Promise<StoredMediaRequest[]> {
  return voiceoverOf(irOf(s)) && s.services.media ? [await capped(s, sfxRequest(s).request)] : [];
}

/** The graphic without its accent, and why: the accent is decoration, so a missing provider never fails the job. */
const withoutAccent = (ir: VideoIR, reason: string) => ({
  output: { ir, warning: truncateText(`SFX accent skipped: ${reason}`, 500) },
});

async function voiceRequests(
  s: StageContext,
): Promise<Array<{ line: VoiceLine; request: StoredMediaRequest }>> {
  return Promise.all(
    voiceLineRequests(s).map(async (v) => ({ line: v.line, request: await capped(s, v.request) })),
  );
}

/** The output of a decorative audio stage: the IR, and a warning when its audio was skipped. */
const AccentOutput = IrOutput.extend({ warning: z.string().max(500).optional() });

/**
 * One SFX accent where the CTA card lands, for a graphic with a voice-over. No music: the voice carries the
 * graphic. No media provider, or a call that cannot be made (UNAVAILABLE: no sound-effect model, no key,
 * no price), skips the accent with a warning instead of failing the job. The call itself decides, not the
 * provider's shared capability list: that list is probed on platform keys only, while the call also uses
 * the workspace's own keys; the runner never caches a warned
 * output, so a skipped accent is retried next run. The cache key is the one this stage had when it also
 * voiced the graphic (such a cached output still holds that older voice-over, which the voice stage
 * replaces), so a paid accent is reused.
 */
export const motionGraphicAccentStage: StageDefinition = {
  name: MG_STAGES.accent,
  knowledge: ["sound"],
  outputSchema: AccentOutput,
  cacheKey: (s) => stageCacheKey(MG_STAGES.accent, 2, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) => {
    try {
      return await estimateMediaCents(s, await accentRequests(s));
    } catch (err) {
      if (unavailable(err)) return 0;
      throw err;
    }
  },
  async run(s) {
    const ir = irOf(s);
    if (!voiceoverOf(ir)) return { output: { ir } };
    if (!s.services.media) return withoutAccent(ir, "no media provider is configured");
    const workDir = await stageWorkDir(s, MG_STAGES.accent);
    let sfx: StoredMedia;
    try {
      sfx = await generateStoredMedia(s, MG_STAGES.accent, await capped(s, sfxRequest(s).request));
    } catch (err) {
      if (!unavailable(err)) throw err;
      await rm(workDir, { recursive: true, force: true });
      return withoutAccent(ir, toStudixError(err).message);
    }
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
 * (another speech model, new direction) costs only the voice. A take is judged on its speech, not its
 * silence, and one still too long is voiced once more, brisker (`generateVoiceTake`).
 */
export const motionGraphicVoiceStage: StageDefinition = {
  name: MG_STAGES.voice,
  knowledge: ["voice-performance"],
  outputSchema: IrOutput,
  cacheKey: (s) => stageCacheKey(MG_STAGES.voice, 3, { ir: irOf(s), media: s.services.media?.id ?? null }),
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
      (v) => generateVoiceTake(s, MG_STAGES.voice, v.line, v.request, `${v.request.assetId}-track`, workDir),
      (g) => g.usage,
    );
    await rm(workDir, { recursive: true, force: true });
    const usage = generated.flatMap((g) => g.usage);
    const next = await billedOnFailure(usage, () =>
      VideoIR.parse(
        withVoiceover(
          ir,
          generated.map((g) => g.track),
          generated.map((g) => g.asset),
        ),
      ),
    );
    return { output: { ir: next }, usage };
  },
};
const musicOf = (ir: VideoIR) =>
  typeof ir.metadata?.music === "string" && ir.metadata.music !== "" ? ir.metadata.music : undefined;

/** The music bed the storyboard asked for, the length of the graphic; none when it asked for none. */
async function musicRequests(s: StageContext): Promise<StoredMediaRequest[]> {
  const ir = irOf(s);
  const mood = musicOf(ir);
  if (!mood) return [];
  return [
    await capped(s, {
      assetId: "music-bed",
      kind: "music",
      prompt: `Instrumental music bed, ${mood}, no vocals`,
      params: { durationMs: ir.format.durationMs },
      keyPrefix: `generated/${s.job.id}/music-bed`,
      maxCostCents: 0,
      reuse: {},
    }),
  ];
}

/** Music level under the voice-over: a bed, not a lead. */
const MUSIC_VOLUME = 0.18;

/** The graphic without its music bed, and why: the bed is decoration, so a missing provider never fails the job. */
const withoutMusic = (ir: VideoIR, reason: string) => ({
  output: { ir, warning: truncateText(`Music bed skipped: ${reason}`, 500) },
});

/**
 * An instrumental bed under the whole graphic, only when the agent's storyboard asked for one (a template
 * graphic has none). Its own stage, so a re-voice does not pay for the music again. A call that cannot be
 * made (UNAVAILABLE: no key, no price, no music model) skips the bed with a warning instead of failing the
 * job; the runner never caches a warned output, so the bed is retried next run.
 */
export const motionGraphicMusicStage: StageDefinition = {
  name: MG_STAGES.music,
  knowledge: ["sound"],
  outputSchema: AccentOutput,
  cacheKey: (s) => stageCacheKey(MG_STAGES.music, 1, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) => {
    try {
      return await estimateMediaCents(s, await musicRequests(s));
    } catch (err) {
      if (unavailable(err)) return 0;
      throw err;
    }
  },
  async run(s) {
    const ir = irOf(s);
    let request: StoredMediaRequest | undefined;
    try {
      [request] = await musicRequests(s);
    } catch (err) {
      if (!unavailable(err)) throw err;
      return withoutMusic(ir, toStudixError(err).message);
    }
    if (!request) return { output: { ir } };
    const workDir = await stageWorkDir(s, MG_STAGES.music);
    let music: StoredMedia;
    try {
      music = await generateStoredMedia(s, MG_STAGES.music, request);
    } catch (err) {
      if (!unavailable(err)) throw err;
      await rm(workDir, { recursive: true, force: true });
      return withoutMusic(ir, toStudixError(err).message);
    }
    const next = {
      ...ir,
      assets: [...ir.assets.filter((a) => a.id !== music.asset.id), music.asset],
      audio: [
        ...(ir.audio ?? []).filter((t) => t.id !== "music-bed-track"),
        {
          id: "music-bed-track",
          kind: "music" as const,
          assetId: music.asset.id,
          startMs: 0,
          durationMs: Math.min(ir.format.durationMs, music.asset.durationMs ?? ir.format.durationMs),
          volume: MUSIC_VOLUME,
        },
      ],
    };
    await rm(workDir, { recursive: true, force: true });
    return {
      output: { ir: await billedOnFailure([music.usage], () => VideoIR.parse(next)) },
      usage: [music.usage],
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

/**
 * New project: storyboard (agent, or template fallback) -> compose -> SFX accent -> voice-over -> music bed
 * (when the storyboard asked for one) -> render -> QA -> upload. Re-render of a version:
 * render -> QA -> upload.
 */
export const motionGraphicPipeline: PackPipeline = {
  renderer: "hyperframes",
  stages: (job, e) =>
    job.fromVersion
      ? [e.plan, e.validateIr, e.render, motionGraphicQaStage, e.upload, e.finalize]
      : [
          e.brief,
          motionGraphicStoryboardStage,
          motionGraphicComposeStage,
          motionGraphicAccentStage,
          motionGraphicVoiceStage,
          motionGraphicMusicStage,
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
    motionGraphicStoryboardStage,
    motionGraphicComposeStage,
    motionGraphicAccentStage,
    motionGraphicVoiceStage,
    motionGraphicMusicStage,
    motionGraphicQaStage,
  ],
  pipeline: motionGraphicPipeline,
};
