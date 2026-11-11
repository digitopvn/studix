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
  StageFailedAfterSpend,
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
import { generateVoiceTake, voiceFitScope } from "../voice-takes.ts";
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
   * Lays the SFX accent and the whoosh on each cut. It is named for the time it also voiced the graphic; the
   * name is kept so older jobs still resume.
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
    "HTML/GSAP-first motion graphic (6–60s, default 15s 9:16; a length or aspect ratio stated in the prompt is used when the brief sets none): the workspace's agent writes the script and " +
    "storyboard from the motion knowledge packs (style profile, beats, entrances, optional music bed), " +
    "falling back to brief-derived kinetic cards without an agent (never when the job names its `agent`); a " +
    "generated voice-over with burned captions, a soft whoosh on each cut and one SFX accent on the CTA card; " +
    "the agent's storyboard has about one card every five seconds (3–12); the whoosh, accent and music bed " +
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
      reuse: { scope: voiceFitScope(line) },
    },
  }));
}

const SFX_MS = 1500;
/** Where the accent lands when the IR has no CTA scene: this long before the end. */
const SFX_TAIL_MS = 3000;

/** Where the CTA card starts, or this long before the end when the IR has none. */
function ctaStart(ir: VideoIR): number {
  const ctaIndex = ir.scenes.findIndex((scene) => scene.id === "cta");
  return ctaIndex === -1
    ? Math.max(0, ir.format.durationMs - SFX_TAIL_MS)
    : ir.scenes.slice(0, ctaIndex).reduce((ms, scene) => ms + scene.durationMs, 0);
}

/** One soft accent where the CTA card lands; the voice-over stays the lead. */
function sfxRequest(s: StageContext): { at: number; request: StoredMediaRequest } {
  return {
    at: ctaStart(irOf(s)),
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

const WHOOSH_MS = 700;
/** The whoosh starts this long before its cut, so it sweeps into the next card. */
const WHOOSH_LEAD_MS = 250;
const WHOOSH_VOLUME = 0.35;
const WHOOSH_TRACK = "sfx-whoosh-";

/** Every cut between two cards but the one into the CTA card, which the accent already marks. */
function cutsOf(ir: VideoIR): number[] {
  const cta = ctaStart(ir);
  const cuts: number[] = [];
  let at = 0;
  for (const scene of ir.scenes.slice(0, -1)) {
    at += scene.durationMs;
    if (at !== cta) cuts.push(at);
  }
  return cuts;
}

/**
 * One short whoosh for the cuts, generated once and laid on every cut. Its prompt names no job, so the
 * tenant's stored whoosh is reused instead of paid for again.
 */
function whooshRequest(s: StageContext): StoredMediaRequest {
  return {
    assetId: "sfx-whoosh",
    kind: "sfx",
    prompt: "Short soft airy whoosh transition, clean swish, no chime, no voice",
    params: { durationMs: WHOOSH_MS },
    keyPrefix: `generated/${s.job.id}/sfx-whoosh`,
    maxCostCents: 0,
    reuse: {},
  };
}

/** The whoosh track of each cut, centred so it peaks as the next card comes in. */
function whooshTracks(ir: VideoIR, assetId: string, assetMs: number): VideoIR["audio"] & object {
  return cutsOf(ir).map((cut, i) => {
    const startMs = Math.max(0, cut - WHOOSH_LEAD_MS);
    return {
      id: `${WHOOSH_TRACK}${i + 1}`,
      kind: "sfx" as const,
      assetId,
      startMs,
      durationMs: Math.max(1, Math.min(assetMs, ir.format.durationMs - startMs)),
      volume: WHOOSH_VOLUME,
    };
  });
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

/**
 * The SFX accent and the cut whoosh of a graphic that has a script, uncapped; none for a graphic without one
 * (it has no voice to lead).
 */
function accentRequests(s: StageContext): StoredMediaRequest[] {
  const ir = irOf(s);
  if (!voiceoverOf(ir) || !s.services.media) return [];
  return cutsOf(ir).length > 0 ? [sfxRequest(s).request, whooshRequest(s)] : [sfxRequest(s).request];
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
 * One SFX accent where the CTA card lands and one short whoosh (generated once, laid on every other cut), for
 * a graphic with a voice-over, so no cut is silent. No music: the voice carries the graphic. No media provider, or a call that cannot be made (UNAVAILABLE: no sound-effect model, no key,
 * no price), skips the accent with a warning instead of failing the job. The call itself decides, not the
 * provider's shared capability list: that list is probed on platform keys only, while the call also uses
 * the workspace's own keys; the runner never caches a warned
 * output, so a skipped accent is retried next run. Both sounds are reusable requests, so a new cache key
 * (or another job of the tenant) reuses the stored accent and whoosh instead of paying for them again.
 */
export const motionGraphicAccentStage: StageDefinition = {
  name: MG_STAGES.accent,
  knowledge: ["sound"],
  outputSchema: AccentOutput,
  // Version 3 adds the cut whooshes; the accent itself is a reusable request, so it is not paid for again.
  cacheKey: (s) => stageCacheKey(MG_STAGES.accent, 3, { ir: irOf(s), media: s.services.media?.id ?? null }),
  // Each sound is estimated on its own: one that cannot be made is skipped, the other is still paid for.
  estimateCostCents: async (s) => {
    let total = 0;
    for (const request of accentRequests(s)) {
      try {
        total += await estimateMediaCents(s, [await capped(s, request)]);
      } catch (err) {
        if (!unavailable(err)) throw err;
      }
    }
    return total;
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
    let whoosh: StoredMedia | undefined;
    let warning: string | undefined;
    if (cutsOf(ir).length > 0) {
      try {
        whoosh = await generateStoredMedia(s, MG_STAGES.accent, await capped(s, whooshRequest(s)));
      } catch (err) {
        if (!unavailable(err)) {
          await rm(workDir, { recursive: true, force: true });
          const spent = err instanceof StageFailedAfterSpend ? err.usage : [];
          const cause = err instanceof StageFailedAfterSpend ? err.error : toStudixError(err);
          throw new StageFailedAfterSpend(cause, [sfx.usage, ...spent]);
        }
        warning = truncateText(`Cut whooshes skipped: ${toStudixError(err).message}`, 500);
      }
    }
    const usage = whoosh ? [sfx.usage, whoosh.usage] : [sfx.usage];
    const accentAt = sfxRequest(s).at;
    const accentRoom = Math.max(1, ir.format.durationMs - accentAt);
    const added = whoosh ? [sfx.asset, whoosh.asset] : [sfx.asset];
    const next = {
      ...ir,
      assets: [...ir.assets.filter((a) => !added.some((b) => b.id === a.id)), ...added],
      audio: [
        ...(ir.audio ?? []).filter((t) => t.id !== "sfx-accent-track" && !t.id.startsWith(WHOOSH_TRACK)),
        ...(whoosh ? whooshTracks(ir, whoosh.asset.id, whoosh.asset.durationMs ?? WHOOSH_MS) : []),
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
      output: {
        ir: await billedOnFailure(usage, () => VideoIR.parse(next)),
        ...(warning ? { warning } : {}),
      },
      usage,
    };
  },
};

/** Lines voiced at once: every line of a short graphic, a bounded share of a long one's twelve. */
const VOICE_CONCURRENCY = 6;

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
      VOICE_CONCURRENCY,
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
