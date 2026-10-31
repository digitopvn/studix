import { rm } from "node:fs/promises";
import { join } from "node:path";
import { USAGE_KINDS } from "@studix/billing";
import { StudixError } from "@studix/shared";
import {
  type AssetRef,
  type AudioTrack,
  CreativeBrief,
  exportJsonSchemas,
  resolveRenderSpec,
  type Shot,
  VideoIR,
} from "@studix/video-ir";
import {
  downloadIrAssets,
  fileExists,
  irOf,
  jobScopedId,
  mapBounded,
  type PackPipeline,
  payloadOf,
  RenderOutput,
  read,
  requireService,
  type StageContext,
  type StageDefinition,
  type StageUsage,
  sha256File,
  stageCacheKey,
  stageWorkDir,
  ValidateOutput,
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
import { MARKETING_SCRIPT_VERSION, MarketingScript, marketingScript } from "./marketing-script.ts";
import {
  beatKey,
  MARKETING_TEMPLATE_VERSION,
  marketingVideoIr,
  marketingVideoTemplate,
} from "./marketing-video-template.ts";
import { irVariants, type VariantSpan, variantIr } from "./marketing-video-variants.ts";

export const MARKETING_VIDEO_PACK = "marketing-video";
export const MV_STAGES = {
  script: "marketing-video.script",
  storyboard: "marketing-video.storyboard",
  reframe: "marketing-video.reframe",
  i2v: "marketing-video.i2v",
  audio: "marketing-video.audio",
  render: "marketing-video.render",
  qa: "marketing-video.qa",
  publish: "marketing-video.publish",
} as const;

/** Parallel upstream calls per stage: enough to hide queue latency, few enough to stay polite. */
const MEDIA_CONCURRENCY = 3;
/** Per-call ceiling over the provider's own estimate; the provider refuses anything above it. */
const capOf = (estimateCents: number) => Math.max(5, Math.ceil(estimateCents * 2));
/** Shortest clip image-to-video models reliably accept; a shorter beat plays the head of the clip. */
const MIN_CLIP_MS = 4_000;
const MAX_CLIP_MS = 10_000;

let creativeBriefSchema: Record<string, unknown> | undefined;
export const marketingVideoSkill: Skill = {
  id: MARKETING_VIDEO_PACK,
  title: "Marketing video",
  description:
    "Short vertical ads, one per creative direction (brief.directions): same brand kit, language and length " +
    "(default 9:16, 20s). Script with a voice-over word budget, storyboard frames for review, then " +
    "image-to-video, voice-over, music and SFX, render and a blocking QA gate.",
  version: 1,
  get inputSchema() {
    creativeBriefSchema ??= exportJsonSchemas()["creative-brief"];
    return structuredClone(creativeBriefSchema);
  },
  output: "video-ir",
  run: (input, options) => marketingVideoTemplate(input, options),
};

const BriefOutput = z.object({ brief: CreativeBrief });
const ScriptOutput = z.object({ script: MarketingScript });
const IrOutput = z.object({ ir: VideoIR });

const ScriptInput = z.object({ outputs: z.object({ brief: BriefOutput }) });
type ScriptInput = z.infer<typeof ScriptInput>;

/** Brief -> per-ad script (beats, on-screen lines, voice-over within budget). Pure and free. */
export const marketingScriptStage: StageDefinition = {
  name: MV_STAGES.script,
  knowledge: ["creative-direction", "narrative", "voice-performance"],
  inputSchema: ScriptInput,
  outputSchema: ScriptOutput,
  cacheKey: (s) =>
    stageCacheKey(MV_STAGES.script, MARKETING_SCRIPT_VERSION, (s.input as ScriptInput).outputs.brief),
  async run(s) {
    const { brief } = (s.input as ScriptInput).outputs.brief;
    return { output: { script: marketingScript(brief) } };
  },
};

const StoryboardInput = z.object({
  outputs: z.object({ brief: BriefOutput, [MV_STAGES.script]: ScriptOutput }),
});
type StoryboardInput = z.infer<typeof StoryboardInput>;

/**
 * Scene framing per aspect ratio. It describes the shot only: words like "advertising frame" or "poster"
 * make the model paint a framed poster or a sign inside the image.
 */
const COMPOSITION: Readonly<Record<string, string>> = {
  "9:16":
    "tall portrait composition, full-bleed photograph, subject in the middle with open space above and below",
  "16:9": "wide landscape composition, full-bleed photograph",
  "1:1": "square composition, full-bleed photograph",
  "4:5": "portrait composition, full-bleed photograph",
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` without any of `words` (whole words, any case), with the spacing tidied up. */
function withoutWords(text: string, words: readonly string[]): string {
  let out = text;
  for (const word of words) {
    const w = word.trim();
    if (w.length < 2) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(w)}(?![\\p{L}\\p{N}])`, "giu"), "");
  }
  return out
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The still each beat's frame is generated from: the scene, the ad's look, the brand palette and the
 * framing for the aspect ratio. No brand words reach the image model, even when a direction's concept
 * names the brand: the logo, wordmark and on-screen text are the HyperFrames overlay's job.
 */
export function framePrompt(
  visual: string,
  visualStyle: string | undefined,
  brief: z.infer<typeof CreativeBrief>,
  aspectRatio: string,
): string {
  const brand = brief.brand;
  const brandWords = brand ? [brand.name, ...(brand.tagline ? [brand.tagline] : [])] : [];
  const palette = brand
    ? `colour palette ${brand.palette.primary}, ${brand.palette.background}${brand.palette.accent ? `, ${brand.palette.accent}` : ""}`
    : "";
  return [
    withoutWords(visual, brandWords),
    visualStyle ? withoutWords(visualStyle, brandWords) : undefined,
    `${COMPOSITION[aspectRatio] ?? `${aspectRatio} composition, full-bleed photograph`}, cinematic lighting`,
    palette,
    "no text or lettering anywhere, no logos, no signage, no watermark",
  ]
    .filter(Boolean)
    .join(". ");
}

function frameRequests(s: StageContext): Array<StoredMediaRequest & { key: string }> {
  const input = s.input as StoryboardInput;
  const { brief } = input.outputs.brief;
  const { script } = input.outputs[MV_STAGES.script];
  return script.ads.flatMap((ad) =>
    ad.beats.map((beat) => {
      const key = beatKey(ad.id, beat.id);
      return {
        key,
        assetId: `${key}-frame`,
        kind: "image" as const,
        prompt: framePrompt(beat.visual, ad.visualStyle, brief, script.aspectRatio),
        params: { aspectRatio: script.aspectRatio },
        keyPrefix: `generated/${s.job.id}/storyboard/${key}`,
        maxCostCents: 0,
      };
    }),
  );
}

async function withCaps<T extends StoredMediaRequest>(s: StageContext, requests: T[]): Promise<T[]> {
  const media = requireService(s, "media");
  return Promise.all(
    requests.map(async (r) => {
      const estimate = await media.estimateCostCents({
        kind: r.kind,
        prompt: r.prompt,
        maxCostCents: 1_000_000,
        ...(r.params ? { params: r.params } : {}),
      });
      return { ...r, maxCostCents: capOf(estimate) };
    }),
  );
}

/**
 * Script -> storyboard: one still per beat from the worker's (cheap) image model, stored in the workspace,
 * placed into the IR that the dashboard review shows. Stops there: nothing animates until a person
 * approves the storyboard.
 */
export const marketingStoryboardStage: StageDefinition = {
  name: MV_STAGES.storyboard,
  knowledge: ["art-direction", "dop-camera", "composition-timing"],
  inputSchema: StoryboardInput,
  outputSchema: IrOutput.extend({ frames: z.record(z.string(), z.unknown()) }),
  cacheKey: (s) =>
    stageCacheKey(MV_STAGES.storyboard, MARKETING_TEMPLATE_VERSION, {
      input: s.input,
      media: s.services.media?.id ?? null,
    }),
  estimateCostCents: async (s) => estimateMediaCents(s, await withCaps(s, frameRequests(s))),
  async run(s) {
    const input = s.input as StoryboardInput;
    const { brief } = input.outputs.brief;
    const { script } = input.outputs[MV_STAGES.script];
    const workDir = await stageWorkDir(s, MV_STAGES.storyboard);
    const requests = await withCaps(s, frameRequests(s));
    let done = 0;
    const generated = await mapBounded(
      requests,
      MEDIA_CONCURRENCY,
      async (r) => {
        const media = await generateStoredMedia(s, MV_STAGES.storyboard, r);
        s.reportProgress(++done / requests.length);
        return { key: r.key, ...media };
      },
      (r) => [r.usage],
    );
    const frames = Object.fromEntries(generated.map((g) => [g.key, g.asset]));
    const title = brief.title ?? brief.brand?.name ?? "Marketing video";
    const ir = marketingVideoIr(script, brief.brand, title, { frames });
    await rm(workDir, { recursive: true, force: true });
    return { output: { ir, frames }, usage: generated.map((g) => g.usage) };
  },
};

const ReframeInput = z.object({
  payload: z.object({ projectId: z.string().min(1), versionId: z.string().min(1) }),
  outputs: z.object({
    brief: BriefOutput,
    plan: z.object({ ir: VideoIR, versionId: z.string().min(1) }),
  }),
});
type ReframeInput = z.infer<typeof ReframeInput>;

/**
 * The frames a feedback patch made stale: every image shot whose description (`alt`) differs from the
 * version the patch was written against, or that version did not have. Everything else keeps its frame.
 */
async function reframeRequests(s: StageContext): Promise<Array<StoredMediaRequest & { shotId: string }>> {
  const input = s.input as ReframeInput;
  const { ir, versionId } = input.outputs.plan;
  const { brief } = input.outputs.brief;
  const parent = await s.commit(async (repos, ctx) => {
    const version = await repos.projects.getVersion(ctx, versionId);
    return version?.parentVersionId ? repos.projects.getVersion(ctx, version.parentVersionId) : undefined;
  });
  if (!parent) {
    throw new StudixError("NOT_FOUND", `version ${versionId} has no parent version to compare frames with`, {
      retryable: false,
    });
  }
  const before = new Map(framedShots(parent.ir).map(({ image }) => [image.id, image.alt]));
  return framedShots(ir)
    .filter(({ image }) => image.alt !== undefined && before.get(image.id) !== image.alt)
    .map(({ image }) => {
      const key = image.id.replace(/-media$/, "");
      return {
        shotId: image.id,
        assetId: image.assetId,
        kind: "image" as const,
        prompt: framePrompt(image.alt ?? "", undefined, brief, ir.format.aspectRatio),
        params: { aspectRatio: ir.format.aspectRatio },
        keyPrefix: `generated/${s.job.id}/storyboard/${key}`,
        maxCostCents: 0,
      };
    });
}

/**
 * Reviewer feedback on the storyboard -> new frames for the shots it changed, and back to review. The patch
 * already stored a version with the new shot descriptions; this stage generates a frame for each changed
 * shot only, stores the result as the next version (current, if nobody moved the project on meanwhile) and
 * leaves the project in review. Unchanged shots keep their frames and their review state.
 */
export const marketingReframeStage: StageDefinition = {
  name: MV_STAGES.reframe,
  knowledge: ["art-direction", "dop-camera", "composition-timing"],
  inputSchema: ReframeInput,
  estimateCostCents: async (s) => estimateMediaCents(s, await withCaps(s, await reframeRequests(s))),
  async run(s) {
    const input = s.input as ReframeInput;
    const { ir, versionId } = input.outputs.plan;
    const { projectId } = input.payload;
    const requests = await withCaps(s, await reframeRequests(s));
    const nextVersionId = jobScopedId("pver", s.job.id);
    let generated: Array<StoredMedia & { shotId: string }> = [];
    if (requests.length > 0) {
      const workDir = await stageWorkDir(s, MV_STAGES.reframe);
      let done = 0;
      generated = await mapBounded(requests, MEDIA_CONCURRENCY, async (r) => {
        const media = await generateStoredMedia(s, MV_STAGES.reframe, r);
        s.reportProgress(++done / requests.length);
        return { shotId: r.shotId, ...media };
      });
      await rm(workDir, { recursive: true, force: true });
    }
    const fresh = new Map(generated.map((g) => [g.asset.id, g.asset]));
    const next = VideoIR.parse({ ...ir, assets: ir.assets.map((a) => fresh.get(a.id) ?? a) });
    const resultVersionId = generated.length > 0 ? nextVersionId : versionId;
    await s.commit(async (repos, ctx) => {
      if (generated.length > 0 && !(await repos.projects.getVersion(ctx, nextVersionId))) {
        await repos.projects.createVersion(ctx, {
          id: nextVersionId,
          projectId,
          ir: next,
          source: "planner",
          parentVersionId: versionId,
          createdBy: { type: "system", id: ctx.actor.id },
          // Only on top of the patched version: a newer version means someone moved on, so stop here.
          advanceFrom: versionId,
        });
      }
      await repos.projects.update(ctx, projectId, { status: "in_review" });
    });
    return {
      output: {
        projectVersionId: resultVersionId,
        storyboard: "in_review",
        reframed: generated.map((g) => g.shotId),
      },
      usage: generated.map((g) => g.usage),
    };
  },
};

/** Clip length for a beat: the beat rounded up to whole seconds, within what i2v models accept. */
const clipMs = (beatMs: number) =>
  Math.min(MAX_CLIP_MS, Math.max(MIN_CLIP_MS, Math.ceil(beatMs / 1000) * 1000));

type ImageShot = Extract<Shot, { type: "image" }>;

function framedShots(ir: z.infer<typeof VideoIR>): Array<{ scene: number; shot: number; image: ImageShot }> {
  return ir.scenes.flatMap((scene, si) =>
    scene.shots.flatMap((shot, i) => (shot.type === "image" ? [{ scene: si, shot: i, image: shot }] : [])),
  );
}

function clipRequests(s: StageContext) {
  const ir = irOf(s);
  return framedShots(ir).map(({ scene, shot, image }) => ({
    scene,
    shot,
    image,
    request: {
      assetId: `${image.id.replace(/-media$/, "")}-clip`.slice(0, 64),
      kind: "video" as const,
      prompt: `${image.alt}. Subtle cinematic camera move, natural motion, no text.`,
      params: {
        durationMs: clipMs(image.durationMs),
        aspectRatio: ir.format.aspectRatio,
        generateAudio: false,
      },
      keyPrefix: `generated/${s.job.id}/clips/${image.id}`,
      maxCostCents: 0,
    } satisfies StoredMediaRequest,
  }));
}

/**
 * Approved storyboard -> clips: every frame animated with the worker's image-to-video model (Seedance 2.5
 * at 480p by default), the image shots replaced by muted video shots. Spends real money, so it only runs
 * once a person approved the storyboard.
 */
export const marketingI2vStage: StageDefinition = {
  name: MV_STAGES.i2v,
  requiresApprovedStoryboard: true,
  knowledge: ["dop-camera", "physics-lite", "production-failure-modes"],
  outputSchema: IrOutput,
  cacheKey: (s) => stageCacheKey(MV_STAGES.i2v, 1, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) =>
    estimateMediaCents(
      s,
      await withCaps(
        s,
        clipRequests(s).map((c) => c.request),
      ),
    ),
  async run(s) {
    const ir = irOf(s);
    const storage = requireService(s, "storage");
    const workDir = await stageWorkDir(s, MV_STAGES.i2v);
    const shots = clipRequests(s);
    const capped = await withCaps(
      s,
      shots.map((c) => c.request),
    );
    // The frames are inputs: fetched from storage and hash-checked, then handed over as local files.
    const frameIds = new Set(shots.map((c) => c.image.assetId));
    const frameFiles = await downloadIrAssets(
      storage,
      s.ctx,
      { ...ir, assets: ir.assets.filter((a) => frameIds.has(a.id)) },
      join(workDir, "frames"),
    );
    let done = 0;
    const clips = await mapBounded(
      shots,
      MEDIA_CONCURRENCY,
      async (c, i) => {
        const request = capped[i] as StoredMediaRequest;
        const media = await generateStoredMedia(s, MV_STAGES.i2v, {
          ...request,
          params: { ...request.params, image: frameFiles[c.image.assetId] },
        });
        s.reportProgress(++done / shots.length);
        return { ...c, ...media };
      },
      (r) => [r.usage],
    );
    const next = structuredClone(ir);
    for (const c of clips) {
      const scene = next.scenes[c.scene];
      if (!scene) continue;
      scene.shots[c.shot] = {
        id: c.image.id,
        type: "video",
        startMs: c.image.startMs,
        durationMs: c.image.durationMs,
        assetId: c.asset.id,
        muted: true,
        fit: "cover",
      };
    }
    next.assets = [...next.assets, ...clips.map((c) => c.asset)];
    await rm(workDir, { recursive: true, force: true });
    const usage = clips.map((c) => c.usage);
    return { output: { ir: await billedOnFailure(usage, () => VideoIR.parse(next)) }, usage };
  },
};

function spokenText(ir: z.infer<typeof VideoIR>, v: VariantSpan): string {
  return (ir.captions?.cues ?? [])
    .filter((c) => c.startMs >= v.startMs && c.endMs <= v.startMs + v.durationMs)
    .map((c) => c.text)
    .join(" ");
}

function audioRequests(s: StageContext) {
  const ir = irOf(s);
  const mood = [...(ir.brand?.voice ?? [])].join(", ") || "warm, confident";
  return irVariants(ir).flatMap((v) => {
    const spoken = spokenText(ir, v);
    const base = `generated/${s.job.id}/audio/${v.id}`;
    const ad = ir.scenes.find((sc) => sc.id === v.sceneId);
    const cta = ad?.shots.find((sh) => sh.type === "cta");
    return [
      ...(spoken
        ? [
            {
              variant: v,
              role: "voiceover" as const,
              at: v.startMs + 300,
              request: {
                assetId: `${v.id}-vo`.slice(0, 64),
                kind: "voice" as const,
                prompt: spoken,
                params: { language: ir.language },
                keyPrefix: `${base}-vo`,
                maxCostCents: 0,
              } satisfies StoredMediaRequest,
            },
          ]
        : []),
      {
        variant: v,
        role: "music" as const,
        at: v.startMs,
        request: {
          assetId: `${v.id}-music`.slice(0, 64),
          kind: "music" as const,
          prompt: `Instrumental advertising music bed, ${mood}, modern, steady pulse, no vocals`,
          params: { durationMs: v.durationMs },
          keyPrefix: `${base}-music`,
          maxCostCents: 0,
        } satisfies StoredMediaRequest,
      },
      {
        variant: v,
        role: "sfx" as const,
        at: v.startMs + (cta?.startMs ?? Math.max(0, v.durationMs - 3000)),
        request: {
          assetId: `${v.id}-sfx`.slice(0, 64),
          kind: "sfx" as const,
          prompt: "Soft airy whoosh into a gentle chime, clean, short",
          params: { durationMs: 1500 },
          keyPrefix: `${base}-sfx`,
          maxCostCents: 0,
        } satisfies StoredMediaRequest,
      },
    ];
  });
}

/**
 * Voice-over (the captioned lines), a music bed and one SFX accent per ad, generated and mixed into the IR:
 * voice at full level, music ducked under it, the accent on the end card.
 */
export const marketingAudioStage: StageDefinition = {
  name: MV_STAGES.audio,
  requiresApprovedStoryboard: true,
  knowledge: ["sound", "voice-performance"],
  outputSchema: IrOutput,
  cacheKey: (s) => stageCacheKey(MV_STAGES.audio, 1, { ir: irOf(s), media: s.services.media?.id ?? null }),
  estimateCostCents: async (s) =>
    estimateMediaCents(
      s,
      await withCaps(
        s,
        audioRequests(s).map((a) => a.request),
      ),
    ),
  async run(s) {
    const ir = irOf(s);
    const workDir = await stageWorkDir(s, MV_STAGES.audio);
    const planned = audioRequests(s);
    const capped = await withCaps(
      s,
      planned.map((a) => a.request),
    );
    let done = 0;
    const generated = await mapBounded(
      planned,
      MEDIA_CONCURRENCY,
      async (a, i) => {
        const media = await generateStoredMedia(s, MV_STAGES.audio, capped[i] as StoredMediaRequest);
        s.reportProgress(++done / planned.length);
        return { ...a, ...media };
      },
      (r) => [r.usage],
    );
    const tracks: AudioTrack[] = generated.map((g) => {
      const end = g.variant.startMs + g.variant.durationMs;
      const room = end - g.at;
      const length = g.role === "music" ? room : Math.min(room, g.asset.durationMs ?? room);
      return {
        id: `${g.asset.id}-track`.slice(0, 64),
        kind: g.role,
        assetId: g.asset.id,
        startMs: g.at,
        durationMs: Math.max(1, length),
        volume: g.role === "voiceover" ? 1 : g.role === "music" ? 0.35 : 0.6,
        ...(g.role === "music" ? { fadeInMs: 300, fadeOutMs: 800 } : {}),
      };
    });
    const assets: AssetRef[] = generated.map((g) => g.asset);
    const next = {
      ...ir,
      assets: [...ir.assets.filter((a) => !assets.some((b) => b.id === a.id)), ...assets],
      audio: [...(ir.audio ?? []).filter((t) => !tracks.some((n) => n.id === t.id)), ...tracks],
    };
    await rm(workDir, { recursive: true, force: true });
    const usage = generated.map((g) => g.usage);
    return { output: { ir: await billedOnFailure(usage, () => VideoIR.parse(next)) }, usage };
  },
};

const RenderedVariants = z.object({
  variants: z.array(
    z.object({ id: z.string(), name: z.string(), durationMs: z.number(), render: RenderOutput }),
  ),
});

/** Every ad rendered as its own file with the worker's renderer (HyperFrames). */
export const marketingRenderStage: StageDefinition = {
  name: MV_STAGES.render,
  outputSchema: RenderedVariants,
  // Render files are worker-local: reusable only on the same worker, or once publish has stored them.
  isCheckpointValid: async (output, saved) => {
    if (saved[MV_STAGES.publish] !== undefined) return true;
    const parsed = RenderedVariants.safeParse(output);
    if (!parsed.success) return false;
    for (const v of parsed.data.variants) if (!(await fileExists(v.render.filePath))) return false;
    return true;
  },
  async run(s) {
    const ir = irOf(s);
    const renderer = requireService(s, "renderer");
    const storage = requireService(s, "storage");
    const spec = resolveRenderSpec(payloadOf(s).renderPreset);
    const root = await stageWorkDir(s, MV_STAGES.render);
    const variants = irVariants(ir);
    const out = [];
    for (const [i, v] of variants.entries()) {
      const one = variantIr(ir, v);
      const support = renderer.supports(one, spec);
      if (!support.supported) {
        throw new StudixError("VALIDATION", `Renderer ${renderer.id} cannot render ad ${v.id}`, {
          retryable: false,
          details: { reasons: support.reasons },
        });
      }
      const workDir = join(root, v.id);
      await rm(workDir, { recursive: true, force: true });
      const assetFiles = await downloadIrAssets(storage, s.ctx, one, join(workDir, "assets"));
      const rendered = await renderer.render(one, {
        spec,
        workDir,
        assetFiles,
        signal: s.signal,
        deadlineAt: s.job.deadlineAt,
        onProgress: (p) => s.reportProgress((i + p.progress) / variants.length),
      });
      out.push({
        id: v.id,
        name: v.name,
        durationMs: v.durationMs,
        render: { filePath: rendered.filePath, mime: rendered.mime, probe: rendered.probe },
      });
    }
    const seconds = out.reduce((n, v) => n + v.render.probe.durationMs / 1000, 0);
    const usage: StageUsage[] = [
      {
        item: "render",
        kind: USAGE_KINDS.renderSeconds,
        quantity: seconds,
        unit: "s",
        costCents: 0,
        metadata: { renderer: renderer.id, preset: spec.preset, variants: out.length },
      },
    ];
    return { output: { variants: out }, usage };
  },
};

/** The blocking QA gate on every ad: picture, sound, loudness, sync and length; one failure stops the job. */
export const marketingQaStage: StageDefinition = {
  name: MV_STAGES.qa,
  knowledge: ["sound", "production-failure-modes"],
  async run(s) {
    const qa = requireService(s, "qa");
    const ir = irOf(s);
    const { variants } = read(RenderedVariants, s.outputs[MV_STAGES.render], "render checkpoint");
    const reports: Record<string, unknown> = {};
    for (const v of variants) {
      reports[v.id] = await qa.assertPasses(
        v.render.filePath,
        {
          durationMs: v.durationMs,
          fps: ir.format.fps,
          requireAudio: true,
          knowledge: marketingQaStage.knowledge,
        },
        s.signal,
      );
    }
    return { output: { pass: true, reports } };
  },
};

/** Upload every ad that passed QA and record one render per ad; the project goes back to review. */
export const marketingPublishStage: StageDefinition = {
  name: MV_STAGES.publish,
  async run(s) {
    const storage = requireService(s, "storage");
    const payload = payloadOf(s);
    const spec = resolveRenderSpec(payload.renderPreset);
    const { versionId } = read(ValidateOutput, s.outputs.validate_ir, "validate_ir checkpoint");
    const { variants } = read(RenderedVariants, s.outputs[MV_STAGES.render], "render checkpoint");
    const base = jobScopedId("rnd", s.job.id);
    const renders: Array<{
      variant: string;
      name: string;
      renderId: string;
      storageKey: string;
      bytes: number;
      sha256: string;
      probe: z.infer<typeof RenderOutput>["probe"];
    }> = [];
    for (const [i, v] of variants.entries()) {
      const renderId = `${base}${i + 1}`;
      const { sha256 } = await sha256File(v.render.filePath);
      const stored = await storage.put(
        s.ctx,
        `renders/${renderId}/${spec.preset}.mp4`,
        { filePath: v.render.filePath },
        { contentType: v.render.mime, sha256 },
      );
      renders.push({
        variant: v.id,
        name: v.name,
        renderId,
        storageKey: stored.key,
        bytes: stored.bytes,
        sha256: stored.sha256,
        probe: v.render.probe,
      });
    }
    await s.commit(async (repos, ctx) => {
      for (const r of renders) {
        if (await repos.renders.get(ctx, r.renderId)) continue;
        await repos.renders.create(ctx, {
          id: r.renderId,
          projectId: payload.projectId,
          versionId,
          jobId: s.job.id,
          preset: spec.preset,
          spec,
          status: "succeeded",
          storageKey: r.storageKey,
          probe: { ...r.probe, bytes: r.bytes },
          completedAt: new Date(),
        });
      }
      await repos.projects.update(ctx, payload.projectId, { status: "in_review" });
    });
    const root = requireService(s, "workRoot");
    await rm(join(root, s.job.id), { recursive: true, force: true });
    return {
      output: {
        projectVersionId: versionId,
        renders: renders.map(({ probe: _probe, ...r }) => r),
      },
      usage: renders.map((r) => ({
        item: `upload-${r.variant}`,
        kind: USAGE_KINDS.storageBytes,
        quantity: r.bytes,
        unit: "byte",
        costCents: 0,
        metadata: { key: r.storageKey },
      })),
    };
  },
};

/**
 * A new project runs brief -> script -> storyboard and stops for review. Feedback with a patch regenerates
 * the frames of the shots it changed and stops for review again. Rendering an approved version runs
 * i2v -> audio -> render -> QA -> publish; both i2v and audio refuse to run before the storyboard is approved.
 */
export const marketingVideoPipeline: PackPipeline = {
  renderer: "hyperframes",
  stages: (job, e) =>
    job.fromVersion && job.feedback
      ? [e.brief, e.plan, marketingReframeStage]
      : job.fromVersion
        ? [
            e.plan,
            e.validateIr,
            marketingI2vStage,
            marketingAudioStage,
            marketingRenderStage,
            marketingQaStage,
            marketingPublishStage,
          ]
        : [e.brief, marketingScriptStage, marketingStoryboardStage, e.validateIr, e.storyboardReady],
  result: (outputs) =>
    outputs[MV_STAGES.publish] ?? outputs[MV_STAGES.reframe] ?? outputs.storyboard_ready ?? {},
};

export const marketingVideoPack: WorkflowPack = {
  id: MARKETING_VIDEO_PACK,
  title: "Marketing video",
  version: 1,
  templates: [marketingVideoSkill],
  stages: [
    marketingScriptStage,
    marketingStoryboardStage,
    marketingReframeStage,
    marketingI2vStage,
    marketingAudioStage,
    marketingRenderStage,
    marketingQaStage,
    marketingPublishStage,
  ],
  pipeline: marketingVideoPipeline,
};
