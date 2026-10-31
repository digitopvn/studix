import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectStatus } from "@studix/core";
import { FILM_SCENE_MIME, FILM_WEATHER_PRESETS, filmPlateScene } from "@studix/renderers/film-scene";
import { StudixError } from "@studix/shared";
import {
  type AssetRef,
  type AudioTrack,
  type Captions,
  CreativeBrief,
  type FilmProduction,
  filmProductionIssues,
  type Shot,
  type ValidationIssue,
  type VideoIR,
  VideoIR as VideoIRSchema,
} from "@studix/video-ir";
import {
  createAgentStage,
  createCreativeGateStage,
  downloadIrAssets,
  irOf,
  jobScopedId,
  mapBounded,
  markInReview,
  type PackPipeline,
  payloadOf,
  RenderOutput,
  read,
  requireService,
  type StageContext,
  type StageDefinition,
  sha256File,
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
import {
  bibleBoardIr,
  designBoardIr,
  FILM_FPS,
  type FilmMetadata,
  filmOf,
  ShotBoard,
  shotStarts,
  storyboardIr,
} from "./film-boards.ts";
import {
  characterSheetPrompt,
  keyframePrompt,
  motionPrompt,
  musicPrompt,
  setFramePrompt,
} from "./film-prompts.ts";
import {
  FilmScope,
  filmFrameSize,
  isVideoTier,
  productionFromScope,
  type ScopeRule,
  scopeDurationMs,
  scopeIssues,
  scopeShots,
  storyboardFromScope,
} from "./film-scope.ts";

/** Parallel upstream calls per stage. */
const MEDIA_CONCURRENCY = 3;
/** Per-call ceiling over the provider's own estimate; the provider refuses anything above it. */
const capOf = (estimateCents: number) => Math.max(5, Math.ceil(estimateCents * 2));
/** Image-to-video clip bounds; the edit plays the head of a clip longer than its shot. */
const MIN_CLIP_MS = 4_000;
const MAX_CLIP_MS = 10_000;
const clipMs = (shotMs: number) =>
  Math.min(MAX_CLIP_MS, Math.max(MIN_CLIP_MS, Math.ceil(shotMs / 1000) * 1000));
/** Seedance 2.5 on Sume renders at 480p for every narrative clip (owner rule; review cuts never need more). */
const CLIP_RESOLUTION = "480p";
/** Lead-in before a shot's first line, and the gap between lines. */
const LINE_LEAD_MS = 200;
const LINE_GAP_MS = 150;
/** Longest score cue one music call makes; a longer scene plays its cue once, then dialogue and SFX alone. */
const MAX_SCORE_CUE_MS = 30_000;

export interface FilmPackConfig {
  /** Pack id, also the workflowTemplate and the stage name prefix. */
  id: string;
  title: string;
  description: string;
  version: number;
  /** Agent instructions of the scope (bible and beat sheet) stage, beyond the shared contract. */
  scopeInstructions: string;
  /** Agent instructions of the storyboard stage, beyond the shared contract. */
  storyboardInstructions: string;
  /** Pack rules checked with the shared ones before G0 is requested. */
  rules: readonly ScopeRule[];
  /** Brief length when it names none. */
  defaultDurationMs: number;
  /** What the reviewer signs at G0 and G1. */
  gates: { g0: string; g1: string };
  knowledge: {
    scope: string[];
    designs: string[];
    storyboard: string[];
    motion: string[];
    sound: string[];
    qa: string[];
  };
}

export interface FilmPackStageNames {
  scope: string;
  bible: string;
  g0: string;
  designs: string;
  g1: string;
  storyboard: string;
  keyframes: string;
  dialogue: string;
  motion: string;
  lipsync: string;
  score: string;
  continuity: string;
  qa: string;
}

export const filmStageNames = (id: string): FilmPackStageNames => ({
  scope: `${id}.scope`,
  bible: `${id}.bible`,
  g0: `${id}.gate-g0`,
  designs: `${id}.designs`,
  g1: `${id}.gate-g1`,
  storyboard: `${id}.storyboard`,
  keyframes: `${id}.keyframes`,
  dialogue: `${id}.dialogue`,
  motion: `${id}.motion`,
  lipsync: `${id}.lipsync`,
  score: `${id}.score`,
  continuity: `${id}.continuity`,
  qa: `${id}.qa`,
});

/** The shared contract both narrative agents work under, prepended to each pack's own instructions. */
const SCOPE_CONTRACT =
  "Write the scope lock of a short narrative film from the creative brief: the series bible (logline, world, " +
  "tone, a style prompt block, original characters with visual anchors, palette, negatives, handedness and " +
  "voice direction, and sets with their light) and the beat sheet (scenes of shots). Every shot has an id, " +
  "a length in ms, the beat, the camera, its tier (T0 code/GL scene, T1 still with camera motion, T2 " +
  "image-to-video insert, T3 image-to-video full action), its render class, the characters in frame, the " +
  "visible speakers, lipsync (dedicated when a speaker's mouth is on screen, else none), continuity state at " +
  "the end of the shot (keys such as position.<id>, wardrobe.<id>, prop.<id>, direction) with declared " +
  "changes, its spoken lines and at most three SFX cues. Shot lengths add up to the brief's length. A " +
  "lip-synced shot is T2 or T3 and carries exactly one line of its one visible speaker; elsewhere keep " +
  "speakers off screen or in reaction shots. About three spoken words per second at most. Keep the brief's " +
  "language with correct diacritics. Characters, designs and names are original: never a real person, " +
  "brand or existing title. Return only JSON matching the output schema.";

const STORYBOARD_CONTRACT =
  "Write one storyboard panel per shot of the approved scope, in film order, using the approved character " +
  "sheets: `frame` describes the keyframe (staging, screen positions, poses, expressions, props in hand, " +
  "eye lines) consistent with each shot's continuity state; `motion` describes what moves during the shot " +
  "(the action for T2/T3, a slow camera move for T0/T1); `focus` is where a still's camera push ends, in " +
  "frame fractions. Never contradict the scope or the bible. Return only JSON matching the output schema.";

const BriefOutput = z.object({ brief: CreativeBrief });

/** One image request per character sheet and set frame of a scope. */
function designRequests(s: StageContext, scope: FilmScope, stage: string) {
  return [
    ...scope.characters.map((c) => ({
      target: { type: "character" as const, id: c.id },
      request: {
        assetId: `${c.id}-sheet-v1`.slice(0, 64),
        kind: "image" as const,
        prompt: characterSheetPrompt(scope, c),
        params: { aspectRatio: "16:9" },
        keyPrefix: `generated/${s.job.id}/designs/${c.id}-sheet-v1`,
        maxCostCents: 0,
      } satisfies StoredMediaRequest,
    })),
    ...scope.sets.map((set) => ({
      target: { type: "set" as const, id: set.id },
      request: {
        assetId: `${set.id}-set-v1`.slice(0, 64),
        kind: "image" as const,
        prompt: setFramePrompt(scope, set),
        params: { aspectRatio: scope.aspectRatio },
        keyPrefix: `generated/${s.job.id}/designs/${set.id}-set-v1`,
        maxCostCents: 0,
      } satisfies StoredMediaRequest,
    })),
  ].map((d) => ({ ...d, stage }));
}

async function withCaps<T extends { request: StoredMediaRequest }>(
  s: StageContext,
  items: T[],
): Promise<T[]> {
  const media = requireService(s, "media");
  return Promise.all(
    items.map(async (item) => {
      const r = item.request;
      const estimate = await media.estimateCostCents({
        kind: r.kind,
        prompt: r.prompt,
        maxCostCents: 1_000_000,
        ...(r.params ? { params: r.params } : {}),
      });
      return { ...item, request: { ...r, maxCostCents: capOf(estimate) } };
    }),
  );
}

const estimateOf = async (s: StageContext, items: Array<{ request: StoredMediaRequest }>) =>
  estimateMediaCents(
    s,
    (await withCaps(s, items)).map((i) => i.request),
  );

function failIssues(what: string, issues: readonly ValidationIssue[], suggestedAction: string): never {
  throw new StudixError("VALIDATION", `${what}: ${issues.length} problem(s)`, {
    retryable: false,
    details: { issues: issues.slice(0, 20) },
    suggestedAction,
  });
}

/** Statuses in which a creative board may be put in front of a reviewer. */
const REVIEW_OPEN: readonly ProjectStatus[] = ["draft", "planning", "rendering", "in_review"];

/**
 * Store `ir` as a project version a reviewer can open on the dashboard and point the project at it, so the
 * creative gate that follows has something to look at. Deterministic id per job and board: a re-run finds
 * the version instead of adding another.
 */
export async function publishReviewVersion(s: StageContext, ir: VideoIR, board: string): Promise<string> {
  const { projectId } = payloadOf(s);
  const versionId = jobScopedId(`pv${board}`, s.job.id);
  await s.commit(async (repos, ctx) => {
    if (!(await repos.projects.getVersion(ctx, versionId))) {
      await repos.projects.createVersion(ctx, {
        id: versionId,
        projectId,
        ir,
        source: "planner",
        createdBy: { type: "system", id: ctx.actor.id },
      });
    }
    // A retried job can outlive an approve, publish or archive: only a project still being worked on is
    // pointed at the board and handed to review.
    const project = await repos.projects.get(ctx, projectId);
    if (project && REVIEW_OPEN.includes(project.status))
      await repos.projects.update(ctx, projectId, { currentVersionId: versionId });
    await markInReview(repos, ctx, projectId, REVIEW_OPEN);
  });
  return versionId;
}

const withFilm = (ir: VideoIR, film: FilmMetadata): VideoIR =>
  VideoIRSchema.parse({ ...ir, metadata: { ...(ir.metadata ?? {}), film } });

type ImageShot = Extract<Shot, { type: "image" }>;

/** Downloaded file of an IR asset; a missing one would silently turn a conditioned call into a blind one. */
function localFile(files: Readonly<Record<string, string>>, assetId: string): string {
  const path = files[assetId];
  if (!path) throw new StudixError("INTERNAL", `Asset ${assetId} was not downloaded`, { retryable: true });
  return path;
}

/** Replace shots of an IR by id. */
function replaceShots(ir: VideoIR, next: ReadonlyMap<string, Shot>, assets: readonly AssetRef[]): VideoIR {
  const copy = structuredClone(ir);
  for (const scene of copy.scenes) scene.shots = scene.shots.map((shot) => next.get(shot.id) ?? shot);
  const ids = new Set(assets.map((a) => a.id));
  copy.assets = [...copy.assets.filter((a) => !ids.has(a.id)), ...assets];
  return VideoIRSchema.parse(copy);
}

function irShot(ir: VideoIR, id: string): Shot {
  for (const scene of ir.scenes) {
    const shot = scene.shots.find((s) => s.id === id);
    if (shot) return shot;
  }
  throw new StudixError("VALIDATION", `The version has no shot "${id}"`, { retryable: false });
}

function boardsFor(scope: FilmScope, boards: readonly ShotBoard[]): Map<string, ShotBoard> {
  const byId = new Map(boards.map((b) => [b.shotId, b]));
  const ids = scopeShots(scope).map(({ shot }) => shot.id);
  const missing = ids.filter((id) => !byId.has(id));
  const extra = boards.filter((b) => !ids.includes(b.shotId)).map((b) => b.shotId);
  if (missing.length > 0 || extra.length > 0 || byId.size !== boards.length) {
    throw new StudixError("VALIDATION", "The storyboard needs exactly one panel per shot of the scope", {
      retryable: false,
      details: { missing, unknown: extra },
      suggestedAction: "Submit a new job; the storyboard agent must cover every shot once.",
    });
  }
  return byId;
}

/** Spread a line's words over its recorded length by their share of its letters. */
function alignWords(text: string, durationMs: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const letters = words.reduce((n, w) => n + w.length, 0) || 1;
  let at = 0;
  return words.map((w, i) => {
    const length = i === words.length - 1 ? durationMs - at : Math.round((durationMs * w.length) / letters);
    const word = { text: w.slice(0, 200), startMs: at, endMs: Math.max(at + 1, at + length) };
    at = word.endMs;
    return word;
  });
}

/** Builds the stages and pipeline of a narrative film pack (anime, long-form film) from its config. */
export function createFilmPack(config: FilmPackConfig): WorkflowPack {
  const n = filmStageNames(config.id);
  const scopeOutput = z.object({ scope: FilmScope });
  const boardsOutput = z.object({ boards: z.array(ShotBoard).min(1).max(240) });

  const scopeStage = createAgentStage({
    name: n.scope,
    version: config.version,
    inputSchema: z.object({ outputs: z.object({ brief: BriefOutput }) }),
    outputSchema: scopeOutput,
    instructions: `${SCOPE_CONTRACT}\n\n${config.scopeInstructions}`,
    taskInput: (input) => ({
      brief: input.outputs.brief.brief,
      durationMs: input.outputs.brief.brief.durationMs ?? config.defaultDurationMs,
    }),
    limits: { maxTurns: 6, maxTokens: 80_000, maxCostCents: 80, timeoutMs: 300_000 },
  });

  const bibleInput = z.object({ outputs: z.looseObject({ brief: BriefOutput }) });
  /** Scope -> checks -> G0 review board. Free; fails before G0 is ever requested when the scope is wrong. */
  const bibleStage: StageDefinition = {
    name: n.bible,
    knowledge: config.knowledge.scope,
    inputSchema: bibleInput,
    async run(s) {
      const input = s.input as z.infer<typeof bibleInput>;
      const { brief } = input.outputs.brief;
      const { scope } = read(scopeOutput, input.outputs[n.scope], `${n.scope} checkpoint`);
      const issues = scopeIssues(scope, {
        durationMs: brief.durationMs ?? config.defaultDurationMs,
        rules: config.rules,
      });
      if (issues.length > 0)
        failIssues("The scope breaks the production rules", issues, "Submit a new job to rewrite the scope.");
      const film: FilmMetadata = {
        pack: config.id,
        scope,
        production: productionFromScope(scope),
      };
      const ir = bibleBoardIr(scope, { film });
      const reviewVersionId = await publishReviewVersion(s, ir, "g0");
      return { output: { ir, reviewVersionId, durationMs: scopeDurationMs(scope) } };
    },
  };

  const g0 = createCreativeGateStage({ gate: "G0", name: n.g0, summary: config.gates.g0 });
  const g1 = createCreativeGateStage({ gate: "G1", name: n.g1, summary: config.gates.g1 });

  /** After G0: one model sheet per character and one frame per set, shown on the G1 board. */
  const designsStage: StageDefinition = {
    name: n.designs,
    knowledge: config.knowledge.designs,
    estimateCostCents: (s) => estimateOf(s, designRequests(s, filmOf(irOf(s)).scope, n.designs)),
    async run(s) {
      const film = filmOf(irOf(s));
      const { scope } = film;
      const workDir = await stageWorkDir(s, n.designs);
      const planned = await withCaps(s, designRequests(s, scope, n.designs));
      let done = 0;
      const made = await mapBounded(planned, MEDIA_CONCURRENCY, async (d) => {
        const media = await generateStoredMedia(s, n.designs, d.request);
        s.reportProgress(++done / planned.length);
        return { ...d, ...media };
      });
      const sheets = new Map(
        made.filter((m) => m.target.type === "character").map((m) => [m.target.id, m.asset]),
      );
      const sets = new Map(made.filter((m) => m.target.type === "set").map((m) => [m.target.id, m.asset]));
      // Sheets are candidates until a person signs G1; the keyframe stage promotes them.
      const production: FilmProduction = {
        ...film.production,
        characters: film.production.characters.map((bible) => {
          const sheet = sheets.get(bible.characterId);
          return sheet
            ? {
                ...bible,
                references: [
                  ...bible.references.filter((r) => r.id !== sheet.id),
                  {
                    id: sheet.id,
                    assetId: sheet.id,
                    view: "turnaround" as const,
                    status: "candidate" as const,
                    version: bible.identityVersion,
                  },
                ],
              }
            : bible;
        }),
      };
      const ir = designBoardIr(scope, sheets, sets, { film: { ...film, production } });
      const reviewVersionId = await publishReviewVersion(s, ir, "g1");
      await rm(workDir, { recursive: true, force: true });
      return { output: { ir, reviewVersionId }, usage: made.map((m) => m.usage) };
    },
  };

  const storyboardInput = z.object({ outputs: z.record(z.string(), z.unknown()) });
  const storyboardStage = createAgentStage({
    name: n.storyboard,
    version: config.version,
    inputSchema: storyboardInput,
    outputSchema: boardsOutput,
    instructions: `${STORYBOARD_CONTRACT}\n\n${config.storyboardInstructions}`,
    taskInput: (input) => {
      const designs = read(
        z.object({ ir: VideoIRSchema }),
        input.outputs[n.designs],
        `${n.designs} checkpoint`,
      );
      const film = filmOf(designs.ir);
      return {
        scope: film.scope,
        sheets: film.production.characters.map((c) => ({
          characterId: c.characterId,
          references: c.references.map((r) => ({ id: r.id, view: r.view })),
        })),
      };
    },
    limits: { maxTurns: 6, maxTokens: 60_000, maxCostCents: 60, timeoutMs: 300_000 },
  });

  const keyframeRequests = (s: StageContext) => {
    const film = filmOf(irOf(s));
    const { boards } = read(boardsOutput, s.outputs[n.storyboard], "storyboard checkpoint");
    const byShot = boardsFor(film.scope, boards);
    return scopeShots(film.scope).map(({ scene, shot }) => {
      const board = byShot.get(shot.id) as ShotBoard;
      // Identity comes from the first character's sheet: a model sheet conditions better than a prose prompt.
      const lead = shot.characters[0];
      const sheet = lead
        ? film.production.characters
            .find((c) => c.characterId === lead)
            ?.references.find((r) => r.status !== "retired")
        : undefined;
      return {
        shot,
        board,
        sheet,
        request: {
          assetId: `${shot.id}-key`.slice(0, 64),
          kind: "image" as const,
          prompt: keyframePrompt(film.scope, scene.setId, shot, board.frame),
          params: { aspectRatio: film.scope.aspectRatio },
          keyPrefix: `generated/${s.job.id}/keyframes/${shot.id}`,
          maxCostCents: 0,
        } satisfies StoredMediaRequest,
      };
    });
  };

  /** After G1: the approved sheets become canonical, then one keyframe per shot conditioned on them. */
  const keyframesStage: StageDefinition = {
    name: n.keyframes,
    knowledge: config.knowledge.storyboard,
    cacheKey: (s) =>
      stageCacheKey(n.keyframes, config.version, {
        ir: irOf(s),
        boards: s.outputs[n.storyboard],
        media: s.services.media?.id ?? null,
      }),
    estimateCostCents: (s) => estimateOf(s, keyframeRequests(s)),
    async run(s) {
      if (s.outputs[n.g1] === undefined)
        throw new StudixError("APPROVAL_REQUIRED", "Keyframes need the G1 design approval", {
          retryable: false,
        });
      const ir = irOf(s);
      const film = filmOf(ir);
      const storage = requireService(s, "storage");
      const workDir = await stageWorkDir(s, n.keyframes);
      const promoted: FilmProduction = {
        ...film.production,
        characters: film.production.characters.map((c) => ({
          ...c,
          references: c.references.map((r) =>
            r.status === "candidate" && r.version === c.identityVersion
              ? { ...r, status: "canonical" as const }
              : r,
          ),
        })),
      };
      const planned = await withCaps(s, keyframeRequests(s));
      const sheetIds = new Set(planned.flatMap((p) => (p.sheet ? [p.sheet.assetId] : [])));
      const sheetFiles = await downloadIrAssets(
        storage,
        s.ctx,
        { ...ir, assets: ir.assets.filter((a) => sheetIds.has(a.id)) },
        join(workDir, "sheets"),
      );
      let done = 0;
      const made = await mapBounded(planned, MEDIA_CONCURRENCY, async (p) => {
        const image = p.sheet ? localFile(sheetFiles, p.sheet.assetId) : undefined;
        const media = await generateStoredMedia(s, n.keyframes, {
          ...p.request,
          params: { ...p.request.params, ...(image ? { image } : {}) },
        });
        s.reportProgress(++done / planned.length);
        return { ...p, ...media };
      });
      const production: FilmProduction = {
        ...promoted,
        shots: promoted.shots.map((plan) => {
          const sheet = made.find((m) => m.shot.id === plan.shotId)?.sheet;
          return sheet ? { ...plan, conditioningRefs: [sheet.id] } : plan;
        }),
      };
      const designs = ir.assets.filter((a) => a.kind === "image");
      const metadata: FilmMetadata = { ...film, production, boards: made.map((m) => m.board) };
      const next = storyboardIr(
        film.scope,
        new Map(made.map((m) => [m.shot.id, m.asset])),
        designs,
        metadata,
      );
      const issues = filmProductionIssues(production, storyboardFromScope(film.scope, next.assets), "design");
      if (issues.length > 0)
        failIssues("The storyboard breaks continuity", issues, "Submit a new job to redraw the storyboard.");
      await rm(workDir, { recursive: true, force: true });
      return { output: { ir: next }, usage: made.map((m) => m.usage) };
    },
  };

  // ---- From an approved storyboard (the owner's dashboard approval is G2) ----

  const dialogueRequests = (s: StageContext) => {
    const ir = irOf(s);
    const film = filmOf(ir);
    return film.production.dialogue.map((cue) => {
      const bible = film.production.characters.find((c) => c.characterId === cue.characterId);
      const voice = bible?.voice?.voiceRef;
      return {
        cue,
        request: {
          assetId: `${cue.id}-vo`.slice(0, 64),
          kind: "voice" as const,
          prompt: cue.text,
          params: {
            language: bible?.voice?.language ?? film.scope.language,
            ...(voice && /^[A-Za-z0-9_.-]{1,128}$/.test(voice) ? { voice } : {}),
          },
          keyPrefix: `generated/${s.job.id}/dialogue/${cue.id}`,
          maxCostCents: 0,
        } satisfies StoredMediaRequest,
      };
    });
  };

  /** Audio first: every line recorded and aligned (the dialogue master) before any lip-synced clip. */
  const dialogueStage: StageDefinition = {
    name: n.dialogue,
    requiresApprovedStoryboard: true,
    knowledge: config.knowledge.sound,
    cacheKey: (s) =>
      stageCacheKey(n.dialogue, config.version, { ir: irOf(s), media: s.services.media?.id ?? null }),
    estimateCostCents: (s) => estimateOf(s, dialogueRequests(s)),
    async run(s) {
      const ir = irOf(s);
      const film = filmOf(ir);
      const starts = shotStarts(ir);
      const workDir = await stageWorkDir(s, n.dialogue);
      const planned = await withCaps(s, dialogueRequests(s));
      let done = 0;
      const made = await mapBounded(planned, MEDIA_CONCURRENCY, async (p) => {
        const media = await generateStoredMedia(s, n.dialogue, p.request);
        s.reportProgress(++done / planned.length);
        return { ...p, ...media };
      });
      const tracks: AudioTrack[] = [];
      const cues: Captions["cues"] = [];
      const cursor = new Map<string, number>();
      const syncedShots = new Set(
        film.production.shots.filter((p) => p.lipsync === "dedicated").map((p) => p.shotId),
      );
      const master = new Map<string, FilmProduction["dialogue"][number]>();
      for (const m of made) {
        const span = starts.get(m.cue.shotId);
        if (!span) throw new StudixError("VALIDATION", `No shot "${m.cue.shotId}" for line ${m.cue.id}`);
        const shotEnd = span.startMs + span.durationMs;
        // A lip-synced line starts with its shot: the sync pass drives the mouth from the clip's first frame.
        const synced = syncedShots.has(m.cue.shotId);
        const at = cursor.get(m.cue.shotId) ?? span.startMs + (synced ? 0 : LINE_LEAD_MS);
        const recorded = m.asset.durationMs ?? Math.ceil((m.cue.text.split(/\s+/).length / 3) * 1000);
        const length = Math.max(1, Math.min(recorded, shotEnd - at));
        cursor.set(m.cue.shotId, at + length + LINE_GAP_MS);
        tracks.push({
          id: `${m.cue.id}-dx`.slice(0, 64),
          kind: "dialogue",
          assetId: m.asset.id,
          startMs: at,
          durationMs: length,
          volume: 1,
        });
        cues.push({ startMs: at, endMs: at + length, text: m.cue.text.slice(0, 300) });
        master.set(m.cue.id, {
          ...m.cue,
          status: "master",
          audioAssetId: m.asset.id,
          alignment: { words: alignWords(m.cue.text, recorded) },
        });
      }
      const production: FilmProduction = {
        ...film.production,
        dialogue: film.production.dialogue.map((c) => master.get(c.id) ?? c),
      };
      const assets = made.map((m) => m.asset);
      const next = withFilm(
        {
          ...ir,
          assets: [...ir.assets.filter((a) => !assets.some((b) => b.id === a.id)), ...assets],
          audio: [...(ir.audio ?? []).filter((t) => t.kind !== "dialogue"), ...tracks],
          ...(cues.length > 0
            ? {
                captions: {
                  language: film.scope.language,
                  mode: "burned" as const,
                  position: "bottom" as const,
                  cues,
                },
              }
            : {}),
        },
        { ...film, production },
      );
      await rm(workDir, { recursive: true, force: true });
      return { output: { ir: next }, usage: made.map((m) => m.usage) };
    },
  };

  const clipRequests = (s: StageContext) => {
    const ir = irOf(s);
    const film = filmOf(ir);
    const boards = new Map((film.boards ?? []).map((b) => [b.shotId, b]));
    return scopeShots(film.scope)
      .filter(({ shot }) => isVideoTier(shot.tier))
      .map(({ shot }) => {
        const still = irShot(ir, shot.id);
        if (still.type !== "image")
          throw new StudixError("VALIDATION", `Shot ${shot.id} has no keyframe to animate`, {
            retryable: false,
          });
        return {
          shot,
          still,
          request: {
            assetId: `${shot.id}-clip`.slice(0, 64),
            kind: "video" as const,
            prompt: motionPrompt(film.scope, shot, boards.get(shot.id)?.motion ?? shot.beat),
            params: {
              durationMs: clipMs(shot.durationMs),
              aspectRatio: film.scope.aspectRatio,
              generateAudio: false,
              resolution: CLIP_RESOLUTION,
            },
            keyPrefix: `generated/${s.job.id}/clips/${shot.id}`,
            maxCostCents: 0,
          } satisfies StoredMediaRequest,
        };
      });
  };

  /**
   * Keyframes -> moving shots: T2/T3 through image-to-video at 480p, T0/T1 as film-engine scenes (a camera push
   * and the shot's weather over the keyframe, a versioned code asset rendered by HyperFrames).
   */
  const motionStage: StageDefinition = {
    name: n.motion,
    requiresApprovedStoryboard: true,
    knowledge: config.knowledge.motion,
    cacheKey: (s) =>
      stageCacheKey(n.motion, config.version, { ir: irOf(s), media: s.services.media?.id ?? null }),
    estimateCostCents: (s) => estimateOf(s, clipRequests(s)),
    async run(s) {
      const ir = irOf(s);
      const film = filmOf(ir);
      const storage = requireService(s, "storage");
      const workDir = await stageWorkDir(s, n.motion);
      const planned = await withCaps(s, clipRequests(s));
      const keyIds = new Set(planned.map((p) => (p.still as ImageShot).assetId));
      const keyFiles = await downloadIrAssets(
        storage,
        s.ctx,
        { ...ir, assets: ir.assets.filter((a) => keyIds.has(a.id)) },
        join(workDir, "keyframes"),
      );
      let done = 0;
      const total = scopeShots(film.scope).length;
      const clips = await mapBounded(planned, MEDIA_CONCURRENCY, async (p) => {
        const media = await generateStoredMedia(s, n.motion, {
          ...p.request,
          params: { ...p.request.params, image: localFile(keyFiles, (p.still as ImageShot).assetId) },
        });
        s.reportProgress(++done / total);
        return { ...p, ...media };
      });
      const next = new Map<string, Shot>();
      const assets: AssetRef[] = [];
      for (const c of clips) {
        next.set(c.shot.id, {
          id: c.shot.id,
          type: "video",
          startMs: c.still.startMs,
          durationMs: c.still.durationMs,
          assetId: c.asset.id,
          muted: true,
          fit: "cover",
        });
        assets.push(c.asset);
      }
      const boards = new Map((film.boards ?? []).map((b) => [b.shotId, b]));
      const size = filmFrameSize(film.scope);
      for (const { shot } of scopeShots(film.scope).filter(({ shot }) => !isVideoTier(shot.tier))) {
        const still = irShot(ir, shot.id);
        if (still.type !== "image")
          throw new StudixError("VALIDATION", `Shot ${shot.id} has no keyframe to animate`, {
            retryable: false,
          });
        const weather = (FILM_WEATHER_PRESETS as readonly string[]).includes(shot.state.weather ?? "")
          ? (shot.state.weather as (typeof FILM_WEATHER_PRESETS)[number])
          : undefined;
        const pkg = filmPlateScene({
          imageAssetId: still.assetId,
          durationMs: shot.durationMs,
          fps: FILM_FPS,
          ...size,
          push: shot.tier === "T0" ? 1.1 : 1.05,
          ...(boards.get(shot.id)?.focus ? { focus: boards.get(shot.id)?.focus } : {}),
          ...(weather ? { weather } : {}),
          lang: film.scope.language,
        });
        const file = join(workDir, `${shot.id}.scene.json`);
        await writeFile(file, JSON.stringify(pkg));
        const { sha256 } = await sha256File(file);
        const stored = await storage.put(
          s.ctx,
          `generated/${s.job.id}/scenes/${shot.id}.json`,
          { filePath: file },
          { contentType: FILM_SCENE_MIME, sha256 },
        );
        const asset: AssetRef = {
          id: `${shot.id}-scene`.slice(0, 64),
          kind: "code",
          storageKey: stored.key,
          sha256: stored.sha256,
          mime: FILM_SCENE_MIME,
          bytes: stored.bytes,
          assetVersionId: `asv_${stored.sha256.slice(0, 24)}`,
          provenance: { source: "generated", provider: "studix-film-engine" },
        };
        assets.push(asset);
        next.set(shot.id, {
          id: shot.id,
          type: "composition",
          startMs: still.startMs,
          durationMs: still.durationMs,
          assetId: asset.id,
        });
        s.reportProgress(++done / total);
      }
      await rm(workDir, { recursive: true, force: true });
      const usage = clips.map((c) => c.usage);
      return { output: { ir: await billedOnFailure(usage, () => replaceShots(ir, next, assets)) }, usage };
    },
  };

  const lipsyncRequests = (s: StageContext) => {
    const ir = irOf(s);
    const film = filmOf(ir);
    return film.production.shots
      .filter((plan) => plan.lipsync === "dedicated")
      .map((plan) => {
        const shot = irShot(ir, plan.shotId);
        const cue = film.production.dialogue.find((c) => c.shotId === plan.shotId);
        if (shot.type !== "video" || !cue?.audioAssetId)
          throw new StudixError(
            "VALIDATION",
            `Shot ${plan.shotId} needs its clip and recorded line before lipsync`,
            {
              retryable: false,
            },
          );
        return {
          shot,
          cue,
          request: {
            assetId: `${plan.shotId}-sync`.slice(0, 64),
            kind: "video" as const,
            prompt: `Lip-sync ${cue.characterId}: ${cue.text}`.slice(0, 500),
            // `audio` routes the request to the lip-sync model; the clip and the line are local files.
            params: { audio: "pending", video: "pending", durationMs: clipMs(shot.durationMs) },
            keyPrefix: `generated/${s.job.id}/lipsync/${plan.shotId}`,
            maxCostCents: 0,
          } satisfies StoredMediaRequest,
        };
      });
  };

  /** Dedicated lip-sync pass (Sume) on every shot with a visible speaker, driven by the dialogue master. */
  const lipsyncStage: StageDefinition = {
    name: n.lipsync,
    requiresApprovedStoryboard: true,
    knowledge: config.knowledge.motion,
    cacheKey: (s) =>
      stageCacheKey(n.lipsync, config.version, { ir: irOf(s), media: s.services.media?.id ?? null }),
    estimateCostCents: (s) => estimateOf(s, lipsyncRequests(s)),
    async run(s) {
      const ir = irOf(s);
      const planned = lipsyncRequests(s);
      if (planned.length === 0) return { output: { ir, lipsynced: 0 } };
      const storage = requireService(s, "storage");
      const workDir = await stageWorkDir(s, n.lipsync);
      const inputs = new Set(
        planned.flatMap((p) => [p.shot.type === "video" ? p.shot.assetId : "", p.cue.audioAssetId ?? ""]),
      );
      const files = await downloadIrAssets(
        storage,
        s.ctx,
        { ...ir, assets: ir.assets.filter((a) => inputs.has(a.id)) },
        join(workDir, "inputs"),
      );
      const capped = await withCaps(s, planned);
      let done = 0;
      const made = await mapBounded(capped, MEDIA_CONCURRENCY, async (p) => {
        const clip = localFile(files, (p.shot as Extract<Shot, { type: "video" }>).assetId);
        const audio = localFile(files, p.cue.audioAssetId as string);
        const media = await generateStoredMedia(s, n.lipsync, {
          ...p.request,
          params: { ...p.request.params, video: clip, audio },
        });
        s.reportProgress(++done / capped.length);
        return { ...p, ...media };
      });
      const next = new Map<string, Shot>(
        made.map((m) => [
          m.shot.id,
          { ...(m.shot as Extract<Shot, { type: "video" }>), assetId: m.asset.id, muted: true },
        ]),
      );
      await rm(workDir, { recursive: true, force: true });
      return {
        output: {
          ir: replaceShots(
            ir,
            next,
            made.map((m) => m.asset),
          ),
          lipsynced: made.length,
        },
        usage: made.map((m) => m.usage),
      };
    },
  };

  const scoreRequests = (s: StageContext) => {
    const ir = irOf(s);
    const film = filmOf(ir);
    const starts = shotStarts(ir);
    const sceneStart = new Map(ir.timeline.entries.map((e) => [e.sceneId, e.startMs]));
    const music = film.scope.scenes.map((scene) => {
      const length = scene.shots.reduce((t, shot) => t + shot.durationMs, 0);
      return {
        role: "music" as const,
        at: sceneStart.get(scene.id) ?? 0,
        length,
        request: {
          assetId: `${scene.id}-score`.slice(0, 64),
          kind: "music" as const,
          prompt: musicPrompt(film.scope, scene),
          params: { durationMs: Math.min(MAX_SCORE_CUE_MS, length) },
          keyPrefix: `generated/${s.job.id}/sound/${scene.id}-score`,
          maxCostCents: 0,
        } satisfies StoredMediaRequest,
      };
    });
    const sfx = scopeShots(film.scope).flatMap(({ shot }) =>
      shot.sfx.map((cue, i) => {
        const span = starts.get(shot.id) ?? { startMs: 0, durationMs: shot.durationMs };
        return {
          role: "sfx" as const,
          at: span.startMs + Math.floor((span.durationMs * i) / Math.max(1, shot.sfx.length)),
          length: span.durationMs,
          request: {
            assetId: `${shot.id}-fx${i + 1}`.slice(0, 64),
            kind: "sfx" as const,
            prompt: cue,
            params: { durationMs: Math.max(500, Math.min(3_000, span.durationMs)) },
            keyPrefix: `generated/${s.job.id}/sound/${shot.id}-fx${i + 1}`,
            maxCostCents: 0,
          } satisfies StoredMediaRequest,
        };
      }),
    );
    return [...music, ...sfx];
  };

  /** OST and SFX on their own buses: one score cue under each scene, each shot's effects on its beat. */
  const scoreStage: StageDefinition = {
    name: n.score,
    requiresApprovedStoryboard: true,
    knowledge: config.knowledge.sound,
    cacheKey: (s) =>
      stageCacheKey(n.score, config.version, { ir: irOf(s), media: s.services.media?.id ?? null }),
    estimateCostCents: (s) => estimateOf(s, scoreRequests(s)),
    async run(s) {
      const ir = irOf(s);
      const workDir = await stageWorkDir(s, n.score);
      const planned = await withCaps(s, scoreRequests(s));
      let done = 0;
      const made = await mapBounded(planned, MEDIA_CONCURRENCY, async (p) => {
        const media = await generateStoredMedia(s, n.score, p.request);
        s.reportProgress(++done / planned.length);
        return { ...p, ...media };
      });
      const total = ir.format.durationMs;
      const tracks: AudioTrack[] = made.map((m) => {
        const room = Math.min(total - m.at, m.length);
        const length = Math.min(room, m.asset.durationMs ?? room);
        return {
          id: `${m.asset.id}-track`.slice(0, 64),
          kind: m.role,
          assetId: m.asset.id,
          startMs: m.at,
          durationMs: Math.max(1, length),
          volume: m.role === "music" ? 0.3 : 0.6,
          ...(m.role === "music" ? { fadeInMs: 500, fadeOutMs: 1_200 } : {}),
        };
      });
      const assets = made.map((m) => m.asset);
      const usage = made.map((m) => m.usage);
      const next = await billedOnFailure(usage, () =>
        VideoIRSchema.parse({
          ...ir,
          assets: [...ir.assets.filter((a) => !assets.some((b) => b.id === a.id)), ...assets],
          audio: [...(ir.audio ?? []).filter((t) => t.kind !== "music" && t.kind !== "sfx"), ...tracks],
        }),
      );
      await rm(workDir, { recursive: true, force: true });
      return { output: { ir: next }, usage };
    },
  };

  /**
   * G3, the rough-cut check before render: the production must be ready for generation (canonical identity
   * on every shot, master dialogue aligned for every lip-synced line, continuity held), every shot moves, and
   * every line is on the dialogue bus.
   */
  const continuityStage: StageDefinition = {
    name: n.continuity,
    knowledge: config.knowledge.qa,
    async run(s) {
      const ir = irOf(s);
      const film = filmOf(ir);
      const issues = filmProductionIssues(
        film.production,
        storyboardFromScope(film.scope, ir.assets),
        "generation",
      );
      for (const { shot } of scopeShots(film.scope)) {
        if (irShot(ir, shot.id).type === "image")
          issues.push({
            path: `/shots/${shot.id}`,
            code: "not_ready",
            message: `shot "${shot.id}" is still a keyframe`,
          });
      }
      const onBus = new Set((ir.audio ?? []).filter((t) => t.kind === "dialogue").map((t) => t.assetId));
      for (const cue of film.production.dialogue) {
        if (!cue.audioAssetId || !onBus.has(cue.audioAssetId))
          issues.push({
            path: `/dialogue/${cue.id}`,
            code: "not_ready",
            message: `line "${cue.id}" is not in the mix`,
          });
      }
      if (issues.length > 0)
        failIssues(
          "The rough cut is not ready to render",
          issues,
          "Fix the listed shots, then render again.",
        );
      return {
        output: { pass: true, shots: scopeShots(film.scope).length, lines: film.production.dialogue.length },
      };
    },
  };

  /** G4, the blocking QA gate on the rendered film: picture, sound, loudness, sync and length. */
  const qaStage: StageDefinition = {
    name: n.qa,
    knowledge: config.knowledge.qa,
    async run(s) {
      const qa = requireService(s, "qa");
      const ir = irOf(s);
      const rendered = read(RenderOutput, s.outputs.render, "render checkpoint");
      const report = await qa.assertPasses(
        rendered.filePath,
        {
          durationMs: ir.format.durationMs,
          fps: ir.format.fps,
          requireAudio: true,
          knowledge: config.knowledge.qa,
        },
        s.signal,
      );
      return { output: { pass: true, report } };
    },
  };

  const pipeline: PackPipeline = {
    renderer: "hyperframes",
    stages: (job, e) =>
      job.fromVersion
        ? [
            e.plan,
            e.validateIr,
            dialogueStage,
            motionStage,
            lipsyncStage,
            scoreStage,
            continuityStage,
            e.render,
            qaStage,
            e.upload,
            e.finalize,
          ]
        : [
            e.brief,
            scopeStage,
            bibleStage,
            g0,
            designsStage,
            g1,
            storyboardStage,
            keyframesStage,
            e.validateIr,
            e.storyboardReady,
          ],
    result: (outputs) => outputs.finalize ?? outputs.storyboard_ready ?? {},
  };

  let scopeSchema: Record<string, unknown> | undefined;
  const template: Skill = {
    id: config.id,
    title: config.title,
    description: config.description,
    version: config.version,
    get inputSchema() {
      scopeSchema ??= z.toJSONSchema(FilmScope, { io: "input", unrepresentable: "any" }) as Record<
        string,
        unknown
      >;
      return structuredClone(scopeSchema);
    },
    output: "video-ir",
    // A host-authored scope becomes the G0 board (previs) directly, checked like an agent's.
    run(input) {
      const parsed = FilmScope.safeParse(input);
      if (!parsed.success)
        throw new StudixError("VALIDATION", `Invalid ${config.id} scope`, {
          retryable: false,
          details: { issues: parsed.error.issues.slice(0, 20) },
        });
      const issues = scopeIssues(parsed.data, { rules: config.rules });
      if (issues.length > 0)
        failIssues("The scope breaks the production rules", issues, "Fix the scope and retry.");
      return bibleBoardIr(parsed.data);
    },
  };

  return {
    id: config.id,
    title: config.title,
    version: config.version,
    templates: [template],
    stages: [
      scopeStage,
      bibleStage,
      g0,
      designsStage,
      g1,
      storyboardStage,
      keyframesStage,
      dialogueStage,
      motionStage,
      lipsyncStage,
      scoreStage,
      continuityStage,
      qaStage,
    ],
    pipeline,
  };
}
