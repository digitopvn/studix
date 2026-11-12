import { rm } from "node:fs/promises";
import { USAGE_KINDS } from "@studix/billing";
import {
  burnedCaptionBand,
  DIRECTOR_SHELL_VERSION,
  frameScale,
  resolvePalette,
  timingWord,
} from "@studix/renderers";
import { toStudixError } from "@studix/shared";
import { CreativeBrief, type Scene, VideoIR } from "@studix/video-ir";
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
import {
  attemptSceneClip,
  clipPath,
  sandboxRenderCents,
  storeClipAsset,
  storeFragment,
  withAuthoredClip,
} from "./motion-graphic-director-clip.ts";
import { authoredRepairMs } from "./motion-graphic-director-repair.ts";
import { sceneClipTiming, sceneWindows, sceneWords } from "./motion-graphic-director-timing.ts";
import { MG_STORYBOARD_STAGE, MotionStoryboardOutput, premiumDirector } from "./motion-graphic-storyboard.ts";

export const MG_DIRECTOR_STAGE = "motion-graphic.authored-scenes";

export { sceneRenderTimeoutSeconds } from "./motion-graphic-director-clip.ts";

/** Smallest text a fragment may set, at a 1080 px short frame edge. */
const MIN_TEXT_AT_1080 = 20;
/** Smallest headline of an authored scene, at a 1080 px short frame edge: the hook reads in a feed. */
const HEADLINE_AT_1080 = 72;

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

const budgetLeft = (s: StageContext) =>
  s.job.budgetCents === undefined ? Number.POSITIVE_INFINITY : s.job.budgetCents - s.job.spentCents;

/**
 * Whether one more builder run and one more render fit in what the job has left. The tier is admitted for one of
 * each; a repair turn (a schema repair inside an agent call, or a builder repair here) is paid from what is left,
 * so a repair the budget cannot hold is skipped and the card stays.
 */
function repairAffordable(s: StageContext, extraCents = 0): boolean {
  return budgetLeft(s) >= extraCents + MG_SCENE_BUILD_LIMITS.maxCostCents + sandboxRenderCents(s);
}

/** Scene numbers whose direction has no focal word left once unspoken words are dropped. */
/** Time kept after a layout repair for the rest of the job: the review's capture and the final render. */
const LAYOUT_REPAIR_MARGIN_MS = 60_000;
/** Whether a layout repair (builder run and sandbox render) still fits before the job's deadline. */
function layoutRepairFits(s: StageContext, durationMs: number): boolean {
  if (!s.job.deadlineAt) return true;
  const left = s.job.deadlineAt.getTime() - Date.now();
  return left >= authoredRepairMs(durationMs) + LAYOUT_REPAIR_MARGIN_MS;
}

const unfocused = (direction: DirectionBrief) =>
  direction.scenes.filter((d) => d.focalWords.length === 0).map((d) => d.scene);

/**
 * What the tier needs before it starts: both agent calls and the sandbox minutes of one render. Repair turns
 * are not reserved; each runs only when what is left still holds it, and every render is checked the same way.
 */
function tierCents(s: StageContext): number {
  return MG_DIRECTION_LIMITS.maxCostCents + MG_SCENE_BUILD_LIMITS.maxCostCents + sandboxRenderCents(s);
}

/**
 * Whether the director tier authors the hook of this job: a premium job on a worker with a sandbox this
 * workspace may use (the sidecar allowlist), storage and an agent harness, not in host mode, with budget left
 * for the whole tier. Decided before anything is paid for; when it is false the graphic is left as it is.
 */
export function directorTierRuns(s: StageContext, sceneCount: number): boolean {
  const compositions = s.services.compositions;
  if (!premiumDirector(s.job.payload) || !compositions || !s.services.storage || !s.agents?.runtime)
    return false;
  if (compositions.allows && !compositions.allows(s.ctx)) return false;
  if ((s.job.payload as { agentMode?: unknown } | undefined)?.agentMode === "host") return false;
  if (sceneCount < 2) return false;
  const left =
    s.job.budgetCents === undefined ? Number.POSITIVE_INFINITY : s.job.budgetCents - s.job.spentCents;
  return left >= tierCents(s);
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

/** Palette roles that colour the film's accents (text, motif, fills), not its page and ink. */
const ACCENT_ROLES = ["accent", "primary", "secondary", "muted"] as const;
type AccentRole = (typeof ACCENT_ROLES)[number];

/**
 * The palette role the rest of the film paints its accents in (motifs, accent text, logo and fills of every
 * other scene), so an authored scene wears the same colour as the cards around it rather than another theme
 * token (a blue `--primary` hook in a gold `--accent` film). A hex colour counts for the role it equals.
 * `accent` when nothing else wins.
 */
export function filmAccentRole(ir: VideoIR, sceneId: string): AccentRole {
  const palette = resolvePalette(ir.brand);
  const counts = new Map<AccentRole, number>();
  const tally = (color: string | undefined) => {
    if (!color) return;
    const role = ACCENT_ROLES.find((r) => r === color || palette[r].toLowerCase() === color.toLowerCase());
    if (role) counts.set(role, (counts.get(role) ?? 0) + 1);
  };
  for (const scene of ir.scenes) {
    if (scene.id === sceneId) continue;
    tally(scene.motif?.color);
    tally(scene.background?.color);
    for (const shot of scene.shots) tally(shot.style?.color);
  }
  let best: AccentRole = "accent";
  for (const role of ACCENT_ROLES) if ((counts.get(role) ?? 0) > (counts.get(best) ?? 0)) best = role;
  return best;
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
  const accent = filmAccentRole(ir, scene.id);
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
      headlinePx: Math.round(HEADLINE_AT_1080 * frameScale(frame)),
    },
    theme: {
      // The colour the cards around this scene use: the builder spends it as the scene's one accent.
      filmAccent: { token: `--${accent}`, color: palette[accent] },
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

/**
 * The direction with each scene's focal words cut to the words that scene really speaks (as the timing spells
 * them): a word the director misheard or took from another scene is dropped, never a reason to lose the tier.
 */
export function spokenFocalWords(ir: VideoIR, direction: DirectionBrief): DirectionBrief {
  return {
    ...direction,
    scenes: direction.scenes.map((d) => {
      const id = ir.scenes[d.scene - 1]?.id;
      if (!id) return { ...d, focalWords: [] };
      const spoken = new Set(sceneWords(ir, id).map(([w]) => w));
      return { ...d, focalWords: d.focalWords.map(timingWord).filter((w) => spoken.has(w)) };
    }),
  };
}

/** A contract or check problem as a repair issue: `html: ...` names the part it is about. */
const problemIssue = (problem: string) => {
  const part = /^(html|css|js):/.exec(problem)?.[1];
  return { path: part ?? "fragment", message: problem };
};

/**
 * An authored scene has no motif, so a match cut into or out of it would fail the planned-IR camera
 * check: those transitions become plain cuts (a match cut is a hard cut already, so timing is unchanged).
 */
export function withoutMotifCuts(ir: VideoIR, scenes: Scene[], sceneId: string): Scene[] {
  const order = ir.timeline.entries.map((e) => e.sceneId);
  const at = order.indexOf(sceneId);
  const touched = new Set([sceneId, at > 0 ? order[at - 1] : undefined]);
  return scenes.map((sc) =>
    touched.has(sc.id) && sc.transitionOut?.kind === "match-cut"
      ? { ...sc, transitionOut: { ...sc.transitionOut, kind: "cut" } }
      : sc,
  );
}

/**
 * Director tier (premium, `roles.director`): the director (strongest configured model) writes a brief for
 * the film, a builder authors the hook scene as an HTML/GSAP fragment on the Studix director shell with the
 * real word timings and beat grid, and the shell, fragment and timing are stored as a composition tree
 * (`compositions/<id>/`, ADR-0024). The skill sandbox checks (`hyperframes check`) and renders the scene to a
 * silent clip, which replaces the hook card as a full-frame video shot; agent-written scripts never reach the
 * in-worker renderer. Any failure (no sandbox, an agent cap, a fragment that breaks the contract, a failed
 * check or render) keeps the template card with a warning, so a premium job never fails where a standard one
 * renders. Both agent calls are tool-less structured output; each may earn one repair turn (the agent gets its
 * rejected output back with what is wrong), paid only from budget that is left. Spend is booked either way.
 */
export const motionGraphicDirectorStage: StageDefinition = {
  name: MG_DIRECTOR_STAGE,
  outputSchema: Output,
  retry: "never",
  // Never more than the job has left: the tier does not run at all when the budget cannot hold it.
  estimateCostCents: (s) => (directorTierRuns(s, irOf(s).scenes.length) ? tierCents(s) : 0),
  async run(s) {
    const ir = irOf(s);
    // Infrastructure, mode or budget: the tier never starts, the graphic is left exactly as it is.
    if (!directorTierRuns(s, ir.scenes.length)) return { output: { ir } };
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

    const booked = (): StageContext => ({
      ...s,
      job: { ...s.job, spentCents: s.job.spentCents + costOf(usage) },
    });
    /** Agent runs the last call made: 2 when it already used its own schema repair turn. */
    let lastRuns = 0;
    const call = async (agent: StageDefinition, input: Record<string, unknown>): Promise<unknown> => {
      try {
        const result = await agent.run({ ...booked(), input });
        usage.push(...(result.usage ?? []));
        lastRuns = (result.usage ?? []).filter((u) => u.kind === USAGE_KINDS.agentRun).length;
        return result.output;
      } catch (err) {
        usage.push(...spentBy(err));
        throw err;
      }
    };
    const workDir = await stageWorkDir(s, MG_DIRECTOR_STAGE);
    try {
      const Direction = z.object({ direction: DirectionBrief });
      const { direction: authored } = Direction.parse(await call(directionAgent, directionInput(s, ir)));
      let direction = spokenFocalWords(ir, authored);
      let missing = unfocused(direction);
      // A scene left without a spoken focal word goes back to the director once, unless its call already
      // used its repair turn or the budget cannot hold the repair and the rest of the tier.
      if (
        missing.length > 0 &&
        lastRuns < 2 &&
        repairAffordable(booked(), MG_DIRECTION_LIMITS.maxCostCents)
      ) {
        const issues = missing.slice(0, 10).map((n) => ({
          path: `direction.scenes.${direction.scenes.findIndex((d) => d.scene === n)}.focalWords`,
          message: `none of these words is spoken in scene ${n}; pick one to three from that scene's words`,
        }));
        try {
          const repair = { issues, output: { direction: authored } };
          const again = Direction.parse(await call(directionAgent, { ...directionInput(s, ir), repair }));
          const next = spokenFocalWords(ir, again.direction);
          if (unfocused(next).length < missing.length) direction = next;
        } catch (err) {
          // The first direction is still sound: a failed repair keeps it, unless the job stops or parks.
          if (s.signal.aborted || err instanceof StageSuspended) throw err;
        }
        missing = unfocused(direction);
      }
      const focalWarning =
        missing.length > 0
          ? `Scene ${missing.join(", ")} of the direction has no spoken focal word; its moves key to beats only`
          : undefined;
      const handoff = Object.fromEntries(
        direction.scenes.flatMap((d) => {
          const id = ir.scenes[d.scene - 1]?.id;
          return id && d.exitRect ? [[id, { exit: d.exitRect }]] : [];
        }),
      );
      const timing = sceneClipTiming(ir, scene.id, handoff);
      const compositionId = directorCompositionId(s.job.id);
      let clip = clipPath(scene.id);
      const task = buildInput(ir, direction, index, timing);
      // One repair turn in all: a fragment that breaks the contract or fails the sandbox check goes back to the
      // builder with what is wrong once, before the card is kept.
      let repair: { issues: Array<{ path: string; message: string }>; output: BuildOutput } | undefined;
      for (;;) {
        const built = (await call(sceneBuildAgent, repair ? { ...task, repair } : task)) as BuildOutput;
        // At most two builder runs in all: none here when the call already used its own schema repair turn.
        const canRepair = !repair && lastRuns < 2 && repairAffordable(booked());
        const attempt = await attemptSceneClip(booked, {
          ir,
          scene,
          built,
          timing,
          compositionId,
          clip,
          // The build task is kept so the visual review can send the scene back to the builder later.
          extra: { timing, direction, task },
          usageItem: `render-${scene.id}${repair ? "-repair" : ""}`,
          usage,
        });
        if (attempt.ok || attempt.kind === "render") record.compositionId = compositionId;
        if (
          attempt.ok &&
          attempt.layout.length > 0 &&
          canRepair &&
          // The render just spent: the repair must still fit the budget and the deadline after it.
          repairAffordable(booked()) &&
          layoutRepairFits(s, scene.durationMs)
        ) {
          // The repair renders beside this clip, so a repair that fails still leaves this one to show.
          const first = { built, clip };
          clip = clipPath(`${scene.id}-reframed`);
          repair = { issues: attempt.layout.map(problemIssue), output: built };
          try {
            const reframed = (await call(sceneBuildAgent, { ...task, repair })) as BuildOutput;
            const again = await attemptSceneClip(booked, {
              ir,
              scene,
              built: reframed,
              timing,
              compositionId,
              clip,
              extra: { timing, direction, task },
              usageItem: `render-${scene.id}-repair`,
              usage,
            });
            if (again.ok) break;
          } catch (err) {
            // The first clip rendered: a repair that throws keeps it, unless the job stops or parks.
            if (s.signal.aborted || err instanceof StageSuspended) throw err;
          }
          // The clipped clip beats the card: put its fragment back in the tree and show it.
          await storeFragment(booked(), compositionId, scene.id, first.built);
          clip = first.clip;
          break;
        }
        if (attempt.ok) break;
        if (attempt.kind === "budget") {
          return keepCard(
            "the job budget left cannot hold the sandbox render after the agents' repair turns",
          );
        }
        if (attempt.kind === "contract") {
          if (canRepair) {
            repair = { issues: attempt.problems.slice(0, 10).map(problemIssue), output: built };
            continue;
          }
          return keepCard(`the fragment breaks the contract: ${attempt.problems.slice(0, 3).join("; ")}`);
        }
        if (!repair && lastRuns < 2 && repairAffordable(booked())) {
          const message = `the sandbox check or render failed (${attempt.why}): ${attempt.log.slice(-600)}`;
          repair = { issues: [{ path: "fragment", message }], output: built };
          continue;
        }
        return keepCard(`the sandbox check or render failed (${attempt.why}): ${attempt.log.slice(-240)}`);
      }

      const asset = await storeClipAsset(s, {
        ir,
        scene,
        compositionId,
        clip,
        workDir,
        assetId: `${scene.id}-authored`,
        name: scene.id,
      });
      record.scenes = [{ sceneId: scene.id, status: "authored" }];
      const swapped = withAuthoredClip(ir, scene.id, asset);
      const next = VideoIR.parse({
        ...ir,
        scenes: withoutMotifCuts(ir, swapped.scenes, scene.id),
        assets: swapped.assets,
        metadata: { ...ir.metadata, authoredScenes: [scene.id] },
      });
      return { output: { ir: withRecord(next), ...(focalWarning ? { warning: focalWarning } : {}) }, usage };
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
