import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CompositionManifest,
  compositionContentType,
  compositionFileKey,
  compositionManifestKey,
  loadCompositionManifest,
  mergeManifest,
  saveCompositionManifest,
} from "@studix/core";
import {
  buildDirectorProject,
  burnedCaptionBand,
  checkSceneFragment,
  DIRECTOR_SHELL_VERSION,
  type DirectorProject,
  frameScale,
  resolvePalette,
  type SceneFragment,
  sceneFragmentFile,
} from "@studix/renderers";
import { toStudixError } from "@studix/shared";
import { type AssetRef, CreativeBrief, type Scene, VideoIR } from "@studix/video-ir";
import {
  irOf,
  type StageContext,
  type StageDefinition,
  StageFailedAfterSpend,
  StageSuspended,
  type StageUsage,
  stageWorkDir,
} from "@studix/workflow";
import { z } from "zod";
import { truncateText } from "../vietnamese-safe-text.ts";
import {
  type BuildOutput,
  DirectionBrief,
  directionAgent,
  MG_DIRECTION_LIMITS,
  MG_SCENE_BUILD_LIMITS,
  sceneBuildAgent,
} from "./motion-graphic-director-agents.ts";
import { sceneClipTiming, sceneWindows, sceneWords } from "./motion-graphic-director-timing.ts";
import { MG_STORYBOARD_STAGE, MotionStoryboardOutput, premiumDirector } from "./motion-graphic-storyboard.ts";

export const MG_DIRECTOR_STAGE = "motion-graphic.authored-scenes";

/** Wall time of the sandbox check and render of one authored scene clip. */
const RENDER_TIMEOUT_SECONDS = 600;
/** Smallest text a fragment may set, at a 1080 px short frame edge. */
const MIN_TEXT_AT_1080 = 20;

const Output = z.object({ ir: VideoIR, warning: z.string().max(500).optional() });
const BriefOutput = z.object({ brief: CreativeBrief });

/** What the stage records in `ir.metadata.director`: where the authored scenes live and what became of each. */
export interface DirectorRecord {
  shellVersion: number;
  compositionId?: string;
  scenes: Array<{ sceneId: string; status: "authored" | "card"; reason?: string }>;
}

/** Scene ids whose picture is an authored clip; the visual review never redesigns them as template cards. */
export function authoredScenesOf(ir: VideoIR): string[] {
  const parsed = z.array(z.string()).safeParse(ir.metadata?.authoredScenes);
  return parsed.success ? parsed.data : [];
}

const costOf = (usage: readonly StageUsage[]) => usage.reduce((sum, u) => sum + (u.costCents ?? 0), 0);
const spentBy = (err: unknown) =>
  err instanceof StageSuspended || err instanceof StageFailedAfterSpend ? err.usage : [];
const reasonOf = (err: unknown) =>
  err instanceof StageSuspended
    ? "the agent reached its cap"
    : toStudixError(err instanceof StageFailedAfterSpend ? err.error : err).message;

/** Composition of a job's authored scenes: one per job, so a retried stage writes over its own files. */
export const directorCompositionId = (jobId: string) =>
  `cmp_${jobId
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(-56)
    .padStart(6, "0")}`;

/** Why the director tier cannot run for this job, or undefined when it can. */
function skipReason(s: StageContext, ir: VideoIR): string | undefined {
  if (!s.services.compositions) return "this worker has no skill sandbox to render authored scenes in";
  if (!s.services.storage) return "this worker has no storage for the composition tree";
  if (!s.agents?.runtime) return "this worker runs no agent harness";
  if ((s.job.payload as { agentMode?: unknown } | undefined)?.agentMode === "host")
    return "a host agent runs this job's stages";
  if (ir.scenes.length < 2) return "the graphic has no scene before its call to action";
  return undefined;
}

/** Writes files into the composition tree (created on first use) and saves its manifest. */
async function storeTree(
  s: StageContext,
  id: string,
  files: ReadonlyArray<{ path: string; body: Uint8Array }>,
): Promise<void> {
  const storage = s.services.storage!;
  const existing = await storage.head(s.ctx, compositionManifestKey(id));
  const manifest: CompositionManifest = existing
    ? await loadCompositionManifest(storage, s.ctx, id)
    : { id, title: "Motion graphic: authored scenes", files: [], updatedAt: new Date().toISOString() };
  const written = [];
  for (const f of files) {
    const contentType = compositionContentType(f.path);
    const put = await storage.put(s.ctx, compositionFileKey(id, f.path), f.body, { contentType });
    written.push({ path: f.path, bytes: f.body.byteLength, sha256: put.sha256, contentType });
  }
  await saveCompositionManifest(storage, s.ctx, mergeManifest(manifest, written));
}

/** The project's files, its fragment as stored for later edits, its TIMING and the director's brief. */
async function treeFiles(
  project: DirectorProject,
  sid: string,
  fragment: SceneFragment,
  extra: Record<string, unknown>,
) {
  const enc = new TextEncoder();
  const files: Array<{ path: string; body: Uint8Array }> = [];
  for (const [path, text] of project.files) files.push({ path, body: enc.encode(text) });
  for (const [path, source] of project.copies)
    files.push({ path, body: new Uint8Array(await readFile(source)) });
  files.push({ path: `scenes/${sid}.scene.html`, body: enc.encode(sceneFragmentFile(sid, fragment)) });
  for (const [name, value] of Object.entries(extra))
    files.push({ path: `data/${name}.json`, body: enc.encode(JSON.stringify(value, null, 2)) });
  return files;
}

/** Task input of the director: the brief, the frame and every scene with its line and spoken words. */
function directionInput(s: StageContext, ir: VideoIR) {
  const brief = BriefOutput.safeParse(s.outputs.brief).data?.brief;
  const storyboard = MotionStoryboardOutput.safeParse(s.outputs[MG_STORYBOARD_STAGE]).data?.storyboard;
  const frame = { width: ir.format.width, height: ir.format.height };
  return {
    brief: brief ? (({ brandLogo: _logo, ...rest }) => rest)(brief) : { prompt: ir.title },
    frame: { ...frame, captionBandPx: burnedCaptionBand(frame) },
    style: storyboard?.styleProfile ?? null,
    palette: resolvePalette(ir.brand),
    scenes: sceneWindows(ir).map((w, i) => {
      const beat = storyboard?.beats[i];
      return {
        scene: i + 1,
        id: w.id,
        start: w.startMs / 1000,
        end: w.endMs / 1000,
        onScreen: beat?.onScreen ?? null,
        voiceover: beat?.voiceover ?? null,
        visual: beat?.visual ?? null,
        words: sceneWords(ir, w.id).map(([word]) => word),
      };
    }),
  };
}

/** Task input of one scene's builder: the direction, its scene with word and beat times, the frame and theme. */
function buildInput(
  ir: VideoIR,
  direction: DirectionBrief,
  index: number,
  timing: ReturnType<typeof sceneClipTiming>,
) {
  const scene = ir.scenes[index] as Scene;
  const shot = direction.scenes.find((d) => d.scene === index + 1);
  const next = direction.scenes.find((d) => d.scene === index + 2);
  const words = timing.scenes[scene.id]?.lines.flatMap((l) => l.words) ?? [];
  const beats: number[] = [];
  for (let n = 0; timing.beat0 + n * timing.beatLen < timing.duration; n++)
    beats.push(Math.round((timing.beat0 + n * timing.beatLen) * 1000) / 1000);
  const frame = { width: ir.format.width, height: ir.format.height };
  const palette = resolvePalette(ir.brand);
  return {
    direction: { concept: direction.concept, motif: direction.motif, rhythm: direction.rhythm },
    scene: {
      id: scene.id,
      number: index + 1,
      start: 0,
      end: timing.duration,
      onScreen: scene.shots.find((sh) => sh.type === "title" || sh.type === "text")?.text ?? null,
      shot: shot?.shot ?? null,
      focalWords: shot?.focalWords ?? [],
      exit: shot?.exit ?? null,
      exitRect: shot?.exitRect ?? null,
      words,
      beats: beats.slice(0, 64),
      beatLen: timing.beatLen,
    },
    next: next ? { shot: next.shot } : null,
    frame: {
      ...frame,
      captionBandPx: burnedCaptionBand(frame),
      marginPx: Math.round(0.05 * Math.min(frame.width, frame.height)),
      minTextPx: Math.round(MIN_TEXT_AT_1080 * frameScale(frame)),
    },
    theme: {
      tokens: {
        "--bg": palette.background,
        "--ink": palette.foreground,
        "--primary": palette.primary,
        "--secondary": palette.secondary,
        "--accent": palette.accent,
        "--muted": palette.muted,
        "--mute / --faint / --hair / --surface": "ink at 56% / 32% / 12% / 5%",
        "--font-heading / --font-body / --font-mono": [
          ir.brand?.fonts.heading,
          ir.brand?.fonts.body,
          "JetBrains Mono",
        ],
      },
    },
  };
}

/** The scene whose picture is now the rendered clip, muted (the film's mix carries the sound). */
function authoredScene(scene: Scene, asset: AssetRef): Scene {
  // The clip owns its whole picture: no template camera move, depth planes or motif drawn over it.
  const { camera: _camera, depth: _depth, motif: _motif, ...rest } = scene;
  return {
    ...rest,
    shots: [
      {
        id: asset.id,
        type: "video",
        assetId: asset.id,
        startMs: 0,
        durationMs: scene.durationMs,
        muted: true,
        fit: "cover",
        style: { region: "full" },
        // The clip carries its own motion; the scene transition still cuts it in.
        animation: { enter: "none", exit: "none" },
      },
    ],
  };
}

/**
 * Director tier (premium, `roles.director`): the director (strongest configured model) writes a brief for
 * the film, a builder authors the hook scene as an HTML/GSAP fragment on the Studix director shell with the
 * real word timings and beat grid, and the shell, fragment and timing are stored as a composition tree
 * (`compositions/<id>/`, ADR-0024). The skill sandbox checks (`hyperframes check`) and renders the scene to a
 * silent clip, which replaces the hook card as a full-frame video shot; agent-written scripts never reach the
 * in-worker renderer. Any failure (no sandbox, an agent cap, a fragment that breaks the contract, a failed
 * check or render) keeps the template card with a warning, so a premium job never fails where a standard one
 * renders. Both agent calls are tool-less structured output; spend is booked either way.
 */
export const motionGraphicDirectorStage: StageDefinition = {
  name: MG_DIRECTOR_STAGE,
  outputSchema: Output,
  retry: "never",
  estimateCostCents: (s) => {
    if (!premiumDirector(s.job.payload) || skipReason(s, irOf(s))) return 0;
    const minutes = Math.ceil(RENDER_TIMEOUT_SECONDS / 60);
    return (
      MG_DIRECTION_LIMITS.maxCostCents +
      MG_SCENE_BUILD_LIMITS.maxCostCents +
      minutes * (s.services.compositions?.centsPerMinute ?? 0)
    );
  },
  async run(s) {
    const ir = irOf(s);
    if (!premiumDirector(s.job.payload)) return { output: { ir } };
    const usage: StageUsage[] = [];
    const index = 0;
    const scene = ir.scenes[index] as Scene;
    const record: DirectorRecord = { shellVersion: DIRECTOR_SHELL_VERSION, scenes: [] };
    const withRecord = (next: VideoIR) =>
      VideoIR.parse({ ...next, metadata: { ...next.metadata, director: record } });
    const keepCard = (reason: string) => {
      record.scenes = [{ sceneId: scene.id, status: "card", reason: truncateText(reason, 300) }];
      return {
        output: { ir: withRecord(ir), warning: truncateText(`Authored scene kept its card: ${reason}`, 500) },
        usage,
      };
    };
    const skip = skipReason(s, ir);
    if (skip) return keepCard(skip);

    const booked = (): StageContext => ({
      ...s,
      job: { ...s.job, spentCents: s.job.spentCents + costOf(usage) },
    });
    const call = async (agent: StageDefinition, input: Record<string, unknown>): Promise<unknown> => {
      try {
        const result = await agent.run({ ...booked(), input });
        usage.push(...(result.usage ?? []));
        return result.output;
      } catch (err) {
        usage.push(...spentBy(err));
        throw err;
      }
    };
    const workDir = await stageWorkDir(s, MG_DIRECTOR_STAGE);
    try {
      const { direction } = z
        .object({ direction: DirectionBrief })
        .parse(await call(directionAgent, directionInput(s, ir)));
      const handoff = Object.fromEntries(
        direction.scenes.flatMap((d) => {
          const id = ir.scenes[d.scene - 1]?.id;
          return id && d.exitRect ? [[id, { exit: d.exitRect }]] : [];
        }),
      );
      const timing = sceneClipTiming(ir, scene.id, handoff);
      const built = (await call(sceneBuildAgent, buildInput(ir, direction, index, timing))) as BuildOutput;
      const words = timing.scenes[scene.id]?.lines.flatMap((l) => l.words.map(([w]) => w)) ?? [];
      const checked = checkSceneFragment(built, { sid: scene.id, words });
      if (checked.problems.length > 0) {
        return keepCard(`the fragment breaks the contract: ${checked.problems.slice(0, 3).join("; ")}`);
      }
      const project = buildDirectorProject({
        width: ir.format.width,
        height: ir.format.height,
        timing,
        theme: { palette: resolvePalette(ir.brand), ...(ir.brand ? { fonts: ir.brand.fonts } : {}) },
        scenes: [{ sid: scene.id, fragment: checked }],
      });
      const compositionId = directorCompositionId(s.job.id);
      record.compositionId = compositionId;
      await storeTree(s, compositionId, await treeFiles(project, scene.id, built, { timing, direction }));

      const clip = `out/${scene.id}.mp4`;
      const compositions = s.services.compositions!;
      const run = await compositions.runner.run(booked(), {
        compositionId,
        command: `hyperframes check . && hyperframes render . -o ${clip} --quiet`,
        timeoutSeconds: RENDER_TIMEOUT_SECONDS,
        check: {
          path: clip,
          width: ir.format.width,
          height: ir.format.height,
          durationMs: scene.durationMs,
          durationToleranceMs: 250,
        },
      });
      usage.push({
        item: `render-${scene.id}`.slice(0, 64),
        kind: "compute",
        quantity: Math.round(run.durationMs) / 1000,
        unit: "second",
        costCents: Math.max(1, Math.ceil(run.durationMs / 60_000)) * compositions.centsPerMinute,
        metadata: { exitCode: run.exitCode, compositionId },
      });
      if (run.exitCode !== 0 || (run.check && !run.check.passed)) {
        const why = run.exitCode !== 0 ? `exit ${run.exitCode}` : (run.check?.problems ?? []).join("; ");
        return keepCard(`the sandbox check or render failed (${why}): ${run.log.slice(-240)}`);
      }

      // The clip is copied to an immutable key: the composition's own file changes when the scene is edited.
      const storage = s.services.storage!;
      const local = join(workDir, `${scene.id}.mp4`);
      const { sha256 } = await storage.download(s.ctx, compositionFileKey(compositionId, clip), local);
      const stored = await storage.put(
        s.ctx,
        `generated/${s.job.id}/authored/${scene.id}.mp4`,
        { filePath: local },
        { contentType: "video/mp4", sha256 },
      );
      const asset: AssetRef = {
        id: `${scene.id}-authored`.slice(0, 64),
        kind: "video",
        storageKey: stored.key,
        sha256: stored.sha256,
        mime: "video/mp4",
        bytes: stored.bytes,
        width: ir.format.width,
        height: ir.format.height,
        durationMs: scene.durationMs,
        assetVersionId: `asv_${stored.sha256.slice(0, 24)}`,
        provenance: { source: "generated", provider: "studix-director" },
      };
      record.scenes = [{ sceneId: scene.id, status: "authored" }];
      const next = VideoIR.parse({
        ...ir,
        scenes: ir.scenes.map((sc, i) => (i === index ? authoredScene(sc, asset) : sc)),
        assets: [...ir.assets.filter((a) => a.id !== asset.id), asset],
        metadata: { ...ir.metadata, authoredScenes: [scene.id] },
      });
      return { output: { ir: withRecord(next) }, usage };
    } catch (err) {
      if (s.signal.aborted) {
        throw new StageFailedAfterSpend(
          err instanceof StageFailedAfterSpend ? err.error : toStudixError(err),
          usage,
        );
      }
      return keepCard(reasonOf(err));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
};
