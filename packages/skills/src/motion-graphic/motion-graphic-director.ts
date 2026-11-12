import { rm } from "node:fs/promises";
import { USAGE_KINDS } from "@studix/billing";
import {
  burnedCaptionBand,
  checkSceneFragment,
  DIRECTOR_SHELL_VERSION,
  frameScale,
  resolvePalette,
  sceneFragmentFile,
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
  BuildOutput,
  DirectionBrief,
  directionAgent,
  MG_DIRECTION_LIMITS,
  type SceneRole,
  sceneBuildAgent,
} from "./motion-graphic-director-agents.ts";
import {
  type FilmShell,
  fragmentPath,
  HEADLINE_AT_1080,
  headlinePxOf,
  storeClipAsset,
  withAuthoredClip,
} from "./motion-graphic-director-clip.ts";
import {
  authorScenes,
  BUILD_CONCURRENCY,
  type BuildAttempt,
  checkFilm,
  createBuildGrants,
  EXPECTED_SCENE_CENTS,
  type FilmFormat,
  type FilmJob,
  filmFitsSandbox,
  filmRenderCents,
  filmRenderMsEstimate,
  filmSandboxCents,
  filmSandboxMsEstimate,
  renderFilm,
} from "./motion-graphic-director-film.ts";
import { markNameOf, resolveFilmMark } from "./motion-graphic-director-mark.ts";
import {
  directorFilmTiming,
  sceneClipTiming,
  sceneWindows,
  sceneWords,
} from "./motion-graphic-director-timing.ts";
import { MG_STORYBOARD_STAGE, MotionStoryboardOutput, premiumDirector } from "./motion-graphic-storyboard.ts";
import { finalRenderMsEstimate } from "./motion-graphic-visual-qa.ts";

export const MG_DIRECTOR_STAGE = "motion-graphic.authored-scenes";

export { sceneRenderTimeoutSeconds } from "./motion-graphic-director-clip.ts";

/** Smallest text a fragment may set, at a 1080 px short frame edge. */
const MIN_TEXT_AT_1080 = 20;

/** Sandbox seconds of the film check and render: the go/no-go metric of film mode. */
const FilmMetrics = z.object({
  checkSeconds: z.number().optional(),
  renderSeconds: z.number().optional(),
  authored: z.number().int(),
  cards: z.number().int(),
});
const Output = z.object({
  ir: VideoIR,
  warning: z.string().max(500).optional(),
  film: FilmMetrics.optional(),
});
const BriefOutput = z.object({ brief: CreativeBrief });

/** What the stage records in `ir.metadata.director`: where the authored scenes live and what became of each. */
export interface DirectorRecord {
  shellVersion: number;
  compositionId?: string;
  scenes: Array<{
    sceneId: string;
    status: "authored" | "card";
    reason?: string;
    /** Frames around a cut of this scene show only the background: the visual review repairs it first. */
    blankCut?: boolean;
    /** Text the film check found cut at the frame edge (advisory), handed to a later repair. */
    layout?: string[];
  }>;
  /** Sandbox seconds of the film check and render. */
  film?: { checkSeconds?: number; renderSeconds?: number };
}

/** Scene ids whose picture is an authored clip; the visual review never redesigns them as template cards. */
export function authoredScenesOf(ir: VideoIR): string[] {
  const parsed = z.array(z.string()).safeParse(ir.metadata?.authoredScenes);
  return parsed.success ? parsed.data : [];
}

const DirectorScenes = z.object({
  director: z.object({
    scenes: z.array(
      z.object({
        sceneId: z.string(),
        blankCut: z.boolean().optional(),
        layout: z.array(z.string()).optional(),
      }),
    ),
  }),
});
/** What the director stage noted per authored scene (blank cuts, cut text) for the visual review. */
export function directorNotesOf(ir: VideoIR): Map<string, { blankCut?: boolean; layout?: string[] }> {
  const parsed = DirectorScenes.safeParse(ir.metadata);
  return new Map((parsed.data?.director.scenes ?? []).map((s) => [s.sceneId, s]));
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

const unfocused = (direction: DirectionBrief) =>
  direction.scenes.filter((d) => d.focalWords.length === 0).map((d) => d.scene);

/**
 * What the tier needs before it starts: the director's call, one scene at its expected cost and both sandbox
 * runs at their bounds. Every further builder call is admitted on its own against what is left
 * (`createBuildGrants`), so a tight budget authors fewer scenes instead of rejecting the tier.
 */
export function tierAdmissionCents(s: StageContext, format: FilmFormat): number {
  return MG_DIRECTION_LIMITS.maxCostCents + EXPECTED_SCENE_CENTS + filmSandboxCents(s, format);
}

/** What the tier expects to spend on a film of `sceneCount` scenes: the reservation the stage asks for. */
export function tierExpectedCents(s: StageContext, sceneCount: number, format: FilmFormat): number {
  return MG_DIRECTION_LIMITS.maxCostCents + sceneCount * EXPECTED_SCENE_CENTS + filmSandboxCents(s, format);
}

/**
 * The longest film the storyboard can ask for, at its largest frame: what the tier is admitted against before
 * the film's own format is known.
 */
export const DIRECTOR_NOMINAL_FORMAT: FilmFormat = { durationMs: 60_000, width: 1920, height: 1080, fps: 30 };

/**
 * Whether the director tier authors this job's scenes: a premium job on a worker with a sandbox this workspace
 * may use (the sidecar allowlist), storage and an agent harness, not in host mode, a film short enough for the
 * sandbox, with budget left for the tier's admission. Decided before anything is paid for; when it is false
 * the graphic is left as it is. The deadline is judged separately (`directorTierTimeShort`).
 */
export function directorTierRuns(s: StageContext, sceneCount: number, format: FilmFormat): boolean {
  const compositions = s.services.compositions;
  if (!premiumDirector(s.job.payload) || !compositions || !s.services.storage || !s.agents?.runtime)
    return false;
  if (compositions.allows && !compositions.allows(s.ctx)) return false;
  if ((s.job.payload as { agentMode?: unknown } | undefined)?.agentMode === "host") return false;
  if (sceneCount < 2 || !filmFitsSandbox(format)) return false;
  return budgetLeft(s) >= tierAdmissionCents(s, format);
}

/** Expected wall time of the director's call and of one wave of builders (a repair wave counts as one). */
export const DIRECTOR_CALL_MS_ESTIMATE = 3 * 60_000;
export const BUILD_WAVE_MS_ESTIMATE = 150_000;

/**
 * Wall time the tier needs from its start to a delivered film: the director, the builder waves (plus one for
 * repairs), both sandbox runs, the final render and the margin for the review and upload.
 */
export function directorTierMsEstimate(ir: VideoIR): number {
  const waves = Math.ceil(ir.scenes.length / BUILD_CONCURRENCY) + 1;
  return (
    DIRECTOR_CALL_MS_ESTIMATE +
    waves * BUILD_WAVE_MS_ESTIMATE +
    filmSandboxMsEstimate(ir.format) +
    finalRenderMsEstimate(ir) +
    FILM_MARGIN_MS
  );
}

/** Why the deadline leaves no room for the tier (checked before the director is paid), or undefined. */
export function directorTierTimeShort(s: StageContext, ir: VideoIR): string | undefined {
  if (!s.job.deadlineAt) return undefined;
  const leftMs = s.job.deadlineAt.getTime() - Date.now();
  const needMs = directorTierMsEstimate(ir);
  if (leftMs >= needMs) return undefined;
  return (
    `Director tier skipped: the film needs about ${Math.ceil(needMs / 60_000)} min to author, check and render ` +
    `but the job deadline is ${Math.max(0, Math.floor(leftMs / 60_000))} min away; the template cards are kept. ` +
    "Raise deadlineSeconds to author the scenes"
  );
}

/** Task input of the director: the brief, the frame and every scene with its line and spoken words. */
function directionInput(s: StageContext, ir: VideoIR) {
  const brief = BriefOutput.safeParse(s.outputs.brief).data?.brief;
  const storyboard = MotionStoryboardOutput.safeParse(s.outputs[MG_STORYBOARD_STAGE]).data?.storyboard;
  const frame = { width: ir.format.width, height: ir.format.height };
  return {
    brief: brief ? (({ brandLogo: _logo, ...rest }) => rest)(brief) : { prompt: ir.title },
    brandHasLogo: Boolean(ir.brand?.logoAssetId),
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
 * `accent` when nothing else wins. With `sceneId` "" every scene counts: the film's one accent.
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

/** A scene's role in the film: the hook opens it, the call to action closes it, the rest show the product. */
export const sceneRole = (index: number, count: number): SceneRole =>
  index === 0 ? "hook" : index === count - 1 ? "cta" : "scene";

/**
 * Task input of one scene's builder: the direction (with the film system), its scene with word and beat times
 * relative to the scene's start, its neighbours' shots, the frame and the theme with the film's one accent.
 */
function buildInput(
  ir: VideoIR,
  direction: DirectionBrief,
  index: number,
  timing: ReturnType<typeof sceneClipTiming>,
  accent: AccentRole,
) {
  const scene = ir.scenes[index] as Scene;
  const role = sceneRole(index, ir.scenes.length);
  const shot = direction.scenes.find((d) => d.scene === index + 1);
  const prev = direction.scenes.find((d) => d.scene === index);
  const next = direction.scenes.find((d) => d.scene === index + 2);
  const words = timing.scenes[scene.id]?.lines.flatMap((l) => l.words) ?? [];
  const beats: number[] = [];
  for (let n = 0; timing.beat0 + n * timing.beatLen < timing.duration; n++)
    beats.push(Math.round((timing.beat0 + n * timing.beatLen) * 1000) / 1000);
  const frame = { width: ir.format.width, height: ir.format.height };
  const palette = resolvePalette(ir.brand);
  const line = scene.shots.find((sh) => sh.type === "title" || sh.type === "text")?.text ?? null;
  return {
    direction: {
      concept: direction.concept,
      motif: direction.motif,
      rhythm: direction.rhythm,
      system: direction.system ?? null,
    },
    scene: {
      id: scene.id,
      number: index + 1,
      of: ir.scenes.length,
      role,
      start: 0,
      end: timing.duration,
      // Only the hook and the call to action set their line; every other scene leaves the words to captions.
      ...(role === "scene" ? {} : { onScreen: line }),
      shot: shot?.shot ?? null,
      focalWords: shot?.focalWords ?? [],
      exit: shot?.exit ?? null,
      exitRect: shot?.exitRect ?? null,
      // Where the previous scene left the surface: this scene opens with it there (the hook: the system anchor).
      enterRect: index === 0 ? (direction.system?.anchor ?? null) : (prev?.exitRect ?? null),
      words,
      beats: beats.slice(0, 64),
      beatLen: timing.beatLen,
    },
    prev: prev ? { shot: prev.shot, exit: prev.exit, exitRect: prev.exitRect ?? null } : null,
    next: next ? { shot: next.shot } : null,
    frame: {
      ...frame,
      captionBandPx: burnedCaptionBand(frame),
      marginPx: Math.round(0.05 * Math.min(frame.width, frame.height)),
      minTextPx: Math.round(MIN_TEXT_AT_1080 * frameScale(frame)),
      ...(role === "scene" ? {} : { headlinePx: Math.round(HEADLINE_AT_1080 * frameScale(frame)) }),
    },
    theme: {
      filmAccent: { token: "--film-accent", color: palette[accent] },
      tokens: {
        "--bg": palette.background,
        "--ink": palette.foreground,
        "--film-accent": palette[accent],
        "--primary": palette.primary,
        "--secondary": palette.secondary,
        "--accent": palette.accent,
        "--muted": palette.muted,
        "--mute / --faint / --hair / --surface": "ink at 56% / 32% / 12% / 5%",
        "--u": "1% of the frame's short edge",
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

/**
 * Transitions an authored scene cannot keep: a match cut into or out of one (it has no motif, so the planned-IR
 * camera check would fail) and any transition between two authored scenes (their clips are cut from one film
 * render, so a fade or whip between them would only break the continuous picture). Both become plain cuts; a
 * transition plays inside the scenes it joins, so timing is unchanged.
 */
export function withFilmCuts(ir: VideoIR, scenes: Scene[], authored: ReadonlySet<string>): Scene[] {
  const order = ir.timeline.entries.map((e) => e.sceneId);
  const nextOf = new Map(order.map((id, i) => [id, order[i + 1]]));
  return scenes.map((sc) => {
    const next = nextOf.get(sc.id);
    const t = sc.transitionOut;
    if (!t) return sc;
    if (authored.has(sc.id) && next && authored.has(next))
      return { ...sc, transitionOut: { kind: "cut", durationMs: 0 } };
    if (t.kind === "match-cut" && (authored.has(sc.id) || (next && authored.has(next))))
      return { ...sc, transitionOut: { ...t, kind: "cut" } };
    return sc;
  });
}

/** `withFilmCuts` for one authored scene: its match cuts become plain cuts. */
export function withoutMotifCuts(ir: VideoIR, scenes: Scene[], sceneId: string): Scene[] {
  return withFilmCuts(ir, scenes, new Set([sceneId]));
}

/** Where the surface leaves each scene (`exit`) and where it opens the next (`enter`, the previous exit). */
export function filmHandoff(
  ir: VideoIR,
  direction: DirectionBrief,
): Record<string, { exit?: DirectionRect; enter?: DirectionRect }> {
  const out: Record<string, { exit?: DirectionRect; enter?: DirectionRect }> = {};
  for (const d of direction.scenes) {
    const id = ir.scenes[d.scene - 1]?.id;
    const next = ir.scenes[d.scene]?.id;
    if (!id || !d.exitRect) continue;
    out[id] = { ...out[id], exit: d.exitRect };
    if (next) out[next] = { ...out[next], enter: d.exitRect };
  }
  return out;
}
type DirectionRect = NonNullable<DirectionBrief["scenes"][number]["exitRect"]>;

/** Time kept after the film's sandbox runs on top of the final render: slack for the review and the upload. */
const FILM_MARGIN_MS = 3 * 60_000;

/**
 * Director tier (premium, `roles.director`), film mode: the director (strongest configured model) writes a
 * brief for the film with its system (one product-UI surface, one accent hue, a call to action that mirrors
 * the hook) and, without a brand logo, a mark; builders author every scene in parallel as HTML/GSAP fragments
 * on the Studix director shell v2 with the real word timings and beat grid. The fragments are stored as one
 * composition tree (`compositions/<id>/`, ADR-0024), checked together in the skill sandbox (findings attributed
 * to their scene), rendered together on the film's timing and cut into one silent clip per scene, which
 * replaces that scene's card as a full-frame video shot; agent-written scripts never reach the in-worker
 * renderer. Any scene that fails (a builder cap or budget, a fragment that breaks the contract after its one
 * repair, a check error) keeps its template card with a warning, so a premium job never fails where a standard
 * one renders. Spend is booked either way.
 */
export const motionGraphicDirectorStage: StageDefinition = {
  name: MG_DIRECTOR_STAGE,
  outputSchema: Output,
  retry: "never",
  // Never more than the job has left: the tier does not run at all when the budget cannot admit it.
  estimateCostCents: (s) => {
    const count = irOf(s).scenes.length;
    const ir = irOf(s);
    return directorTierRuns(s, count, ir.format) && !directorTierTimeShort(s, ir)
      ? Math.min(budgetLeft(s), tierExpectedCents(s, count, ir.format))
      : 0;
  },
  async run(s) {
    const ir = irOf(s);
    // Infrastructure, mode or budget: the tier never starts, the graphic is left exactly as it is.
    if (!directorTierRuns(s, ir.scenes.length, ir.format)) return { output: { ir } };
    // The deadline: the tier is skipped before anything is paid for, and says so.
    const short = directorTierTimeShort(s, ir);
    if (short) return { output: { ir, warning: short } };
    const usage: StageUsage[] = [];
    const warnings: string[] = [];
    const record: DirectorRecord = {
      shellVersion: DIRECTOR_SHELL_VERSION,
      scenes: ir.scenes.map((sc) => ({ sceneId: sc.id, status: "card" })),
    };
    const note = (sceneId: string, patch: Partial<DirectorRecord["scenes"][number]>) => {
      record.scenes = record.scenes.map((r) =>
        r.sceneId === sceneId
          ? {
              ...r,
              ...patch,
              ...(patch.reason ? { reason: truncateText(patch.reason, 300) } : {}),
            }
          : r,
      );
    };
    const withRecord = (next: VideoIR) =>
      VideoIR.parse({ ...next, metadata: { ...next.metadata, director: record } });
    const metrics = () => ({
      ...(record.film ?? {}),
      authored: record.scenes.filter((r) => r.status === "authored").length,
      cards: record.scenes.filter((r) => r.status === "card").length,
    });
    const warning = () => (warnings.length > 0 ? { warning: truncateText(warnings.join("; "), 500) } : {});
    const keepCards = (reason: string) => {
      for (const r of record.scenes) if (r.status === "card" && !r.reason) note(r.sceneId, { reason });
      warnings.unshift(`Authored scenes kept their cards: ${reason}`);
      return { output: { ir: withRecord(ir), ...warning(), film: metrics() }, usage };
    };

    const booked = (): StageContext => ({
      ...s,
      job: { ...s.job, spentCents: s.job.spentCents + costOf(usage) },
    });
    /** One agent call on the booked context (or `ctx`); returns its output and how many agent runs it took. */
    const call = async (
      agent: StageDefinition,
      input: Record<string, unknown>,
      ctx: StageContext = booked(),
    ): Promise<{ output: unknown; runs: number }> => {
      try {
        const result = await agent.run({ ...ctx, input });
        usage.push(...(result.usage ?? []));
        const runs = (result.usage ?? []).filter((u) => u.kind === USAGE_KINDS.agentRun).length;
        return { output: result.output, runs };
      } catch (err) {
        usage.push(...spentBy(err));
        throw err;
      }
    };
    const workDir = await stageWorkDir(s, MG_DIRECTOR_STAGE);
    try {
      const Direction = z.object({ direction: DirectionBrief });
      const first = await call(directionAgent, directionInput(s, ir));
      const authoredDirection = Direction.parse(first.output).direction;
      let direction = spokenFocalWords(ir, authoredDirection);
      let missing = unfocused(direction);
      // A scene left without a spoken focal word goes back to the director once, unless its call already
      // used its repair turn or the budget cannot hold the repair and the tier's admission.
      if (
        missing.length > 0 &&
        first.runs < 2 &&
        budgetLeft(booked()) >= MG_DIRECTION_LIMITS.maxCostCents + tierAdmissionCents(s, ir.format)
      ) {
        const issues = missing.slice(0, 10).map((n) => ({
          path: `direction.scenes.${direction.scenes.findIndex((d) => d.scene === n)}.focalWords`,
          message: `none of these words is spoken in scene ${n}; pick one to three from that scene's words`,
        }));
        try {
          const repair = { issues, output: { direction: authoredDirection } };
          const again = Direction.parse(
            (await call(directionAgent, { ...directionInput(s, ir), repair })).output,
          );
          const next = spokenFocalWords(ir, again.direction);
          if (unfocused(next).length < missing.length) direction = next;
        } catch (err) {
          // The first direction is still sound: a failed repair keeps it, unless the job stops or parks.
          if (s.signal.aborted || err instanceof StageSuspended) throw err;
        }
        missing = unfocused(direction);
      }
      if (missing.length > 0)
        warnings.push(
          `Scene ${missing.join(", ")} of the direction has no spoken focal word; its moves key to beats only`,
        );

      const accent = filmAccentRole(ir, "");
      const palette = resolvePalette(ir.brand);
      const filmMark = await resolveFilmMark(s, ir, direction.mark, workDir);
      if (filmMark.warning) warnings.push(filmMark.warning);
      const shell: FilmShell = {
        shellVersion: DIRECTOR_SHELL_VERSION,
        markSymbol: filmMark.mark.symbol,
        markName: markNameOf(ir),
        filmAccent: palette[accent],
      };
      // Each scene leaves its surface at its exit rect and the next one opens there: parallel builders share
      // nothing else, so these rects (and the hook's anchor) are what carry the surface across the cuts.
      const handoff = filmHandoff(ir, direction);
      const tasks = ir.scenes.map((sc, i) =>
        buildInput(ir, direction, i, sceneClipTiming(ir, sc.id, handoff), accent),
      );
      const words = (sid: string) => sceneWords(ir, sid).map(([w]) => w);

      // Fan-out: every scene's builder at once, each call capped at the budget grant it was admitted with.
      const grants = createBuildGrants(() => budgetLeft(booked()), filmSandboxCents(s, ir.format));
      const build = async (
        index: number,
        repair?: { issues: Array<{ path: string; message: string }>; output: BuildOutput },
      ): Promise<BuildAttempt> => {
        const grant = grants.take();
        if (grant === undefined)
          return { failure: "the job budget left cannot hold another builder", runs: 0 };
        try {
          const ctx = booked();
          const capped =
            ctx.job.budgetCents === undefined
              ? ctx
              : { ...ctx, job: { ...ctx.job, budgetCents: ctx.job.spentCents + grant } };
          s.activity?.touch();
          const task = tasks[index] as Record<string, unknown>;
          const { output, runs } = await call(sceneBuildAgent, repair ? { ...task, repair } : task, capped);
          const parsed = BuildOutput.safeParse(output);
          return parsed.success
            ? { built: parsed.data, runs }
            : { failure: "the builder's answer is not a fragment", runs };
        } catch (err) {
          // A stopped or parked job ends the fan-out; any other failure costs this scene alone.
          if (s.signal.aborted || err instanceof StageSuspended) throw err;
          return { failure: reasonOf(err), runs: 2 };
        } finally {
          grants.release(grant);
        }
      };
      const headlinePx = headlinePxOf(ir);
      const authored = await authorScenes({
        count: ir.scenes.length,
        concurrency: BUILD_CONCURRENCY,
        build,
        check: (index, built) => {
          const sid = (ir.scenes[index] as Scene).id;
          return checkSceneFragment(built, {
            sid,
            words: words(sid),
            shellVersion: DIRECTOR_SHELL_VERSION,
            ...(sceneRole(index, ir.scenes.length) === "scene" ? {} : { headlinePx }),
          });
        },
      });
      const built = authored.flatMap((a) => {
        const sid = (ir.scenes[a.index] as Scene).id;
        if ("failure" in a) {
          note(sid, { reason: a.failure });
          return [];
        }
        return [{ sid, index: a.index, built: a.built, checked: a.checked }];
      });
      if (built.length === 0) return keepCards("no scene was authored");

      // Both sandbox runs must still fit before the deadline (with time left for the review and the final render).
      const secondsLeft = () =>
        s.job.deadlineAt
          ? (s.job.deadlineAt.getTime() - Date.now() - FILM_MARGIN_MS - finalRenderMsEstimate(ir)) / 1000
          : Number.POSITIVE_INFINITY;
      if (secondsLeft() * 1000 < filmSandboxMsEstimate(ir.format)) {
        return keepCards("not enough time left before the job deadline for the film check and render");
      }
      const compositionId = directorCompositionId(s.job.id);
      const job: FilmJob = {
        ir,
        compositionId,
        timing: directorFilmTiming(ir, handoff),
        shell,
        mark: filmMark.mark,
        usage,
        data: {
          direction,
          film: shell,
          // data/film.json and data/task-<sid>.json: what a later repair of one scene rebuilds it from.
          ...Object.fromEntries(built.map((b) => [`task-${b.sid}`, tasks[b.index]])),
        },
        fragments: new Map(built.map((b) => [fragmentPath(b.sid), sceneFragmentFile(b.sid, b.built)])),
        secondsLeft,
      };
      // Run 1: one check of the whole film; a scene with an error falls back to its card.
      const checked = await checkFilm(booked, job, built);
      record.compositionId = compositionId;
      record.film = { checkSeconds: checked.seconds };
      s.activity?.touch();
      if (!checked.verdict.readable) return keepCards("the film check gave no readable report");
      if (checked.verdict.film.length > 0)
        return keepCards(`the film check failed: ${checked.verdict.film.slice(0, 2).join("; ")}`);
      const passed = built.filter((b) => {
        const errors = checked.verdict.errors.get(b.sid);
        if (errors) note(b.sid, { reason: `the check failed: ${errors.slice(0, 2).join("; ")}` });
        const layout = checked.verdict.layout.get(b.sid);
        if (layout) note(b.sid, { layout: layout.map((l) => truncateText(l, 200)) });
        return !errors;
      });
      if (passed.length === 0) return keepCards("every authored scene failed the film check");
      if (budgetLeft(booked()) < filmRenderCents(s, ir.format))
        return keepCards("the job budget left cannot hold the film render");
      if (secondsLeft() * 1000 < filmRenderMsEstimate(ir.format))
        return keepCards("not enough time left before the job deadline for the film render");

      // Run 2: render the film once and cut it into a clip per scene.
      const film = await renderFilm(booked, job, passed);
      record.film = { ...record.film, renderSeconds: film.seconds };
      s.activity?.touch();
      if (!film.ok) {
        return keepCards(`the film render failed (${film.why}): ${(film.log ?? "").trim().slice(-300)}`);
      }
      const thrown = new Set(film.thrown);
      const blank = new Map(film.blankCuts.map((b) => [b.sid, b.frames]));
      let next = ir;
      const swapped: string[] = [];
      for (const b of passed) {
        const clip = film.clips.get(b.sid);
        if (!clip || thrown.has(b.sid)) {
          note(b.sid, {
            reason: thrown.has(b.sid) ? "the scene threw in the film render" : "no clip was cut",
          });
          continue;
        }
        const scene = next.scenes.find((sc) => sc.id === b.sid) as Scene;
        try {
          const asset = await storeClipAsset(s, {
            ir: next,
            scene,
            compositionId,
            clip,
            workDir,
            assetId: `${b.sid}-authored`,
            name: b.sid,
          });
          const out = withAuthoredClip(next, b.sid, asset);
          next = VideoIR.parse({ ...next, scenes: out.scenes, assets: out.assets });
        } catch (err) {
          // One clip that cannot be stored keeps its card; the IR is untouched for it, so the record matches.
          if (s.signal.aborted || err instanceof StageSuspended) throw err;
          note(b.sid, { reason: `the clip could not be stored: ${reasonOf(err)}` });
          continue;
        }
        note(b.sid, { status: "authored", ...(blank.has(b.sid) ? { blankCut: true } : {}) });
        swapped.push(b.sid);
      }
      if (swapped.length === 0) return keepCards("no authored clip could be cut from the film");
      const cards = record.scenes.filter((r) => r.status === "card");
      if (cards.length > 0)
        warnings.push(
          `${cards.length} scene${cards.length > 1 ? "s" : ""} kept the template card: ` +
            cards
              .slice(0, 3)
              .map((c) => `${c.sceneId} (${c.reason ?? "not authored"})`)
              .join("; "),
        );
      if (blank.size > 0)
        warnings.push(
          `Scene ${[...blank.keys()].join(", ")} shows a blank frame at a cut; sent to the review`,
        );
      const result = VideoIR.parse({
        ...next,
        scenes: withFilmCuts(next, next.scenes, new Set(swapped)),
        metadata: {
          ...next.metadata,
          authoredScenes: swapped,
          ...(filmMark.generated ? { generatedMark: { kind: filmMark.generated } } : {}),
        },
      });
      return { output: { ir: withRecord(result), ...warning(), film: metrics() }, usage };
    } catch (err) {
      // A parked job resumes later: the stage parks with everything spent so far booked.
      if (err instanceof StageSuspended && !s.signal.aborted) throw new StageSuspended(err.suspension, usage);
      if (s.signal.aborted) {
        throw new StageFailedAfterSpend(
          err instanceof StageFailedAfterSpend ? err.error : toStudixError(err),
          usage,
        );
      }
      return keepCards(reasonOf(err));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
};
