import {
  ASPECT_RATIO_SIZES,
  AspectRatio,
  type AssetRef,
  CharacterBible,
  type FilmProduction,
  filmProductionIssues,
  HexColor,
  IrId,
  LanguageTag,
  MAX_AUDIO_TRACKS,
  type RenderClass,
  ShotPlan,
  STORYBOARD_SCHEMA_VERSION,
  type Storyboard,
  storyboardIssues,
  type ValidationIssue,
} from "@studix/video-ir";
import { z } from "zod";
import { wordCount } from "../caption-chunks.ts";

/**
 * How a shot is produced, cheapest first: `T0` code (a film-engine scene: set, weather, light FX, camera),
 * `T1` a still with film-engine camera motion, `T2` an image-to-video insert from the keyframe, `T3`
 * image-to-video full action. Spend and continuity risk grow with the tier.
 */
export const FILM_TIERS = ["T0", "T1", "T2", "T3"] as const;
export const FilmTier = z.enum(FILM_TIERS);
export type FilmTier = z.infer<typeof FilmTier>;

/** Tiers whose shot is generated as video (and so can carry a lip-synced speaker). */
export const isVideoTier = (tier: FilmTier) => tier === "T2" || tier === "T3";

/** Conversational read the dialogue budget assumes (the same pace as voice-over scripts). */
export const SPOKEN_WORDS_PER_SECOND = 3;
/** Shortest and longest shot a scope may plan; i2v models take 4-10 s clips and the edit trims them. */
export const SHOT_MIN_MS = 1_000;
export const SHOT_MAX_MS = 10_000;
/** Audio tracks one VideoIR carries: every line, every SFX cue and each scene's score cue take one. */
export { MAX_AUDIO_TRACKS };

/** A cast voice: `<voice>`, `<vendor>:<model>` or `<vendor>:<model>@<voice>` (see film-voices.ts). */
export const VOICE_REF =
  /^(?:[A-Za-z0-9_.-]{1,128}|[a-z][a-z0-9-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/:-]{0,159}(?:@[A-Za-z0-9_.-]{1,128})?)$/;

export const ScopeLine = z.object({
  characterId: IrId,
  text: z.string().min(1).max(300),
  delivery: z.string().max(200).optional(),
});
export type ScopeLine = z.infer<typeof ScopeLine>;

export const ScopeShot = ShotPlan.pick({
  renderClass: true,
  visibleSpeakers: true,
  lipsync: true,
  continuityFrom: true,
  boundary: true,
  state: true,
  changes: true,
}).extend({
  id: IrId,
  durationMs: z.number().int().min(SHOT_MIN_MS).max(SHOT_MAX_MS),
  /** What the viewer must understand from the shot. */
  beat: z.string().min(1).max(400),
  camera: z.string().min(1).max(200),
  tier: FilmTier,
  /** Characters in frame. */
  characters: z.array(IrId).max(6),
  /** Spoken lines, in order; a lip-synced shot carries one line of its visible speaker. */
  lines: z.array(ScopeLine).max(4),
  /** Sound effect cues, in order: the sound heard, in English (see `isSoundCue`). */
  sfx: z.array(z.string().min(1).max(200)).max(3),
  /**
   * Cues from `sfx` whose human voice is intended (a crowd, laughter). Only these skip the speech check on
   * generated effects; every other cue that comes back voiced is rejected.
   */
  voicedSfx: z.array(z.string().min(1).max(200)).max(3).optional(),
});
export type ScopeShot = z.input<typeof ScopeShot>;

export const ScopeScene = z.object({
  id: IrId,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(600),
  setId: IrId,
  shots: z.array(ScopeShot).min(1).max(12),
});

export const ScopeCharacter = CharacterBible.pick({
  anchors: true,
  palette: true,
  handedness: true,
  negatives: true,
  acting: true,
}).extend({
  id: IrId,
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(200),
  description: z.string().min(1).max(600),
  voice: z.object({
    direction: z.string().min(1).max(300),
    language: LanguageTag.optional(),
    /** Cast voice, `[<vendor>:<model>][@<voice>]`; the bible keeps it for every line of the character. */
    voiceRef: z.string().regex(VOICE_REF, "must read [<vendor>:<model>][@<voice>]").optional(),
  }),
});
export type ScopeCharacter = z.infer<typeof ScopeCharacter>;

export const ScopeSet = z.object({
  id: IrId,
  description: z.string().min(1).max(500),
  light: z.string().min(1).max(200),
});

/**
 * The scope lock of a narrative film, written by an agent from the brief: series bible (world, tone, style,
 * characters, sets) and the beat sheet (scenes of tiered shots with dialogue and SFX). The person who signs
 * G0 approves exactly this; every later stage reads it.
 */
export const FilmScope = z.object({
  title: z.string().min(1).max(120),
  logline: z.string().min(1).max(400),
  language: LanguageTag,
  aspectRatio: AspectRatio,
  world: z.string().min(1).max(1000),
  tone: z.string().min(1).max(300),
  style: z.object({
    /** Prompt block every generated image starts with. */
    look: z.string().min(1).max(600),
    palette: z.array(HexColor).max(8),
    negatives: z.array(z.string().min(1).max(120)).max(12),
  }),
  characters: z.array(ScopeCharacter).min(1).max(8),
  sets: z.array(ScopeSet).min(1).max(8),
  scenes: z.array(ScopeScene).min(1).max(20),
  music: z.object({ style: z.string().min(1).max(300) }),
});
export type FilmScope = z.output<typeof FilmScope>;
export type FilmScopeInput = z.input<typeof FilmScope>;
export type FilmScopeShot = FilmScope["scenes"][number]["shots"][number];

/** Every shot of the scope, in film order, with its scene. */
export function scopeShots(
  scope: FilmScope,
): Array<{ scene: FilmScope["scenes"][number]; shot: FilmScopeShot }> {
  return scope.scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })));
}

export const scopeDurationMs = (scope: FilmScope) =>
  scopeShots(scope).reduce((n, { shot }) => n + shot.durationMs, 0);

/** Storyboard shot id of a scope shot: scope shot ids are unique across scenes. */
const storyboardKind = (tier: FilmTier) => (isVideoTier(tier) ? "video" : "composition");

/**
 * The storyboard the scope describes: characters, one beat per shot (with its lines), scenes of shots and the
 * continuity links. `assets` are the stored designs and frames referenced so far.
 */
export function storyboardFromScope(scope: FilmScope, assets: readonly AssetRef[] = []): Storyboard {
  const draft = { status: "draft" as const };
  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    title: scope.title,
    language: scope.language,
    aspectRatio: scope.aspectRatio,
    characters: scope.characters.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    assets: [...assets],
    beats: scopeShots(scope).map(({ shot }) => ({
      id: `beat-${shot.id}`.slice(0, 64),
      summary: shot.beat,
      ...(shot.lines.length > 0
        ? {
            dialogue: shot.lines.map((l) => ({
              characterId: l.characterId,
              text: l.text,
              language: scope.language,
            })),
          }
        : {}),
    })),
    scenes: scope.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      summary: scene.summary,
      shots: scene.shots.map((shot) => ({
        id: shot.id,
        kind: storyboardKind(shot.tier),
        description: shot.beat,
        durationMs: shot.durationMs,
        camera: shot.camera,
        beatIds: [`beat-${shot.id}`.slice(0, 64)],
        ...(shot.characters.length > 0 ? { characterIds: [...shot.characters] } : {}),
        ...(shot.continuityFrom ? { dependsOn: [shot.continuityFrom] } : {}),
        approval: draft,
      })),
      approval: draft,
    })),
    approval: draft,
  };
}

/** The production plan the scope starts from: identity v1 bibles without references, temp dialogue. */
export function productionFromScope(scope: FilmScope): FilmProduction {
  return {
    schemaVersion: 1,
    characters: scope.characters.map((c) => ({
      characterId: c.id,
      identityVersion: 1,
      anchors: c.anchors,
      palette: c.palette,
      ...(c.handedness ? { handedness: c.handedness } : {}),
      negatives: c.negatives,
      voice: {
        direction: c.voice.direction,
        ...(c.voice.language ? { language: c.voice.language } : {}),
        ...(c.voice.voiceRef ? { voiceRef: c.voice.voiceRef } : {}),
      },
      ...(c.acting ? { acting: c.acting } : {}),
      references: [],
    })),
    shots: scopeShots(scope).map(({ shot }) => ({
      shotId: shot.id,
      renderClass: shot.renderClass,
      visibleSpeakers: shot.visibleSpeakers,
      lipsync: shot.lipsync,
      ...(shot.continuityFrom ? { continuityFrom: shot.continuityFrom } : {}),
      boundary: shot.boundary,
      state: shot.state,
      changes: shot.changes,
    })),
    dialogue: scopeShots(scope).flatMap(({ shot }) =>
      shot.lines.map((line, i) => ({
        id: lineId(shot.id, i),
        shotId: shot.id,
        characterId: line.characterId,
        text: line.text,
        status: "temp" as const,
      })),
    ),
  };
}

/**
 * Whether an SFX cue can go to the effect model: the sound described in English (plain ASCII). The model
 * reads a cue in another language, such as the film's Vietnamese, aloud as speech instead of making the sound.
 */
export const isSoundCue = (cue: string): boolean => /^[\x20-\x7E]+$/.test(cue);

/** Dialogue cue id of a shot's i-th line (also the stem of its audio asset ids). */
export const lineId = (shotId: string, index: number) => `${shotId}-l${index + 1}`.slice(0, 64);

/** Pack-specific scope rules (tier mix, budget routing), checked with the shared ones. */
export type ScopeRule = (scope: FilmScope) => ValidationIssue[];

export interface ScopeCheckOptions {
  /** Target length from the brief; the scope must land within one second of it. */
  durationMs?: number;
  rules?: readonly ScopeRule[];
}

/**
 * Every problem of a scope before anything is generated: the storyboard and production cross-checks, then
 * the rules every narrative pack shares (a visible speaker is lip-synced through a dedicated pass on a
 * video-tier shot with exactly one line of theirs; lines fit the shot at a conversational pace; sets and
 * scenes resolve), then the pack's own rules.
 */
export function scopeIssues(scope: FilmScope, options: ScopeCheckOptions = {}): ValidationIssue[] {
  const storyboard = storyboardFromScope(scope);
  const issues: ValidationIssue[] = [
    ...storyboardIssues(storyboard),
    ...filmProductionIssues(productionFromScope(scope), storyboard, "plan"),
  ];
  const sets = new Set(scope.sets.map((s) => s.id));
  scope.scenes.forEach((scene, si) => {
    if (!sets.has(scene.setId))
      issues.push({
        path: `/scenes/${si}/setId`,
        code: "unknown_reference",
        message: `unknown set "${scene.setId}"`,
      });
    scene.shots.forEach((shot, i) => {
      const path = `/scenes/${si}/shots/${i}`;
      const words = shot.lines.reduce((n, l) => n + wordCount(l.text), 0);
      const budget = Math.floor((shot.durationMs / 1000) * SPOKEN_WORDS_PER_SECOND);
      if (words > budget)
        issues.push({
          path: `${path}/lines`,
          code: "out_of_bounds",
          message: `${words} spoken words do not fit a ${shot.durationMs / 1000}s shot (at most ${budget})`,
        });
      shot.sfx.forEach((cue, j) => {
        if (!isSoundCue(cue))
          issues.push({
            path: `${path}/sfx/${j}`,
            code: "schema",
            message: `SFX cue "${cue}" must describe the sound in English; the effect model reads other languages aloud`,
          });
      });
      (shot.voicedSfx ?? []).forEach((cue, j) => {
        if (!shot.sfx.includes(cue))
          issues.push({
            path: `${path}/voicedSfx/${j}`,
            code: "unknown_reference",
            message: `voiced SFX cue "${cue}" is not one of the shot's sfx cues`,
          });
      });
      if (shot.lipsync === "native")
        issues.push({
          path: `${path}/lipsync`,
          code: "lipsync",
          message: "lipsync runs as a dedicated pass on the dialogue master; use dedicated or none",
        });
      if (shot.lipsync === "dedicated") {
        if (!isVideoTier(shot.tier))
          issues.push({
            path: `${path}/tier`,
            code: "lipsync",
            message: `a lip-synced shot is generated as video (T2 or T3), not ${shot.tier}`,
          });
        const spoken = shot.lines.filter((l) => shot.visibleSpeakers.includes(l.characterId));
        if (shot.visibleSpeakers.length !== 1 || spoken.length !== 1 || shot.lines.length !== 1)
          issues.push({
            path: `${path}/lines`,
            code: "lipsync",
            message: "a lip-synced shot carries exactly one line, spoken by its one visible speaker",
          });
      }
    });
  });
  const shots = scopeShots(scope);
  const tracks = shots.reduce((n, { shot }) => n + shot.lines.length + shot.sfx.length, scope.scenes.length);
  if (tracks > MAX_AUDIO_TRACKS)
    issues.push({
      path: "/scenes",
      code: "out_of_bounds",
      message: `lines, SFX cues and one score cue per scene need ${tracks} audio tracks; a film carries at most ${MAX_AUDIO_TRACKS}`,
    });
  if (options.durationMs !== undefined) {
    const total = scopeDurationMs(scope);
    if (Math.abs(total - options.durationMs) > 1_000)
      issues.push({
        path: "/scenes",
        code: "timeline",
        message: `shots add up to ${total / 1000}s; the brief asks for ${options.durationMs / 1000}s`,
      });
  }
  for (const rule of options.rules ?? []) issues.push(...rule(scope));
  return issues;
}

/** Frame size of the film (full HD for the aspect ratio). */
export const filmFrameSize = (scope: Pick<FilmScope, "aspectRatio">) => ASPECT_RATIO_SIZES[scope.aspectRatio];

/** Render class of each tier when a pack routes by tier (anime): the spend class the tier implies. */
export const TIER_RENDER_CLASS: Readonly<Record<FilmTier, z.infer<typeof RenderClass>>> = {
  T0: "CHEAP_BROLL",
  T1: "STANDARD",
  T2: "CHARACTER_CRITICAL",
  T3: "HERO",
};
