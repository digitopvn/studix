import { StudixError } from "@studix/shared";
import {
  type AssetRef,
  buildSequentialTimeline,
  type Captions,
  FilmProduction,
  IrId,
  type Scene,
  type Shot,
  unwrapValidation,
  type VideoIR,
  validateVideoIR,
} from "@studix/video-ir";
import { z } from "zod";
import { truncateText } from "../vietnamese-safe-text.ts";
import { FilmScope, filmFrameSize, scopeDurationMs, scopeShots } from "./film-scope.ts";

/** Frame rate of narrative films (the film engine's edit rate). */
export const FILM_FPS = 24;
/** How long a design or bible card stays on screen in a review board. */
const CARD_MS = 3_000;

/** Storyboard panel of one shot, written by the storyboard agent after G1. */
export const ShotBoard = z.object({
  shotId: IrId,
  /** What the keyframe shows: staging, poses, expressions, screen positions, props. */
  frame: z.string().min(1).max(1200),
  /** What moves during the shot (the image-to-video prompt for T2/T3, the push focus for T0/T1). */
  motion: z.string().min(1).max(600),
  /** Where the camera pushes on a still, in frame fractions (T0/T1). */
  focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});
export type ShotBoard = z.infer<typeof ShotBoard>;

/**
 * Production record a narrative film carries inside its VideoIR (`metadata.film`), so a later job on a stored
 * version reads the approved scope, the bibles with their canonical references and the storyboard panels.
 * Renderers ignore it.
 */
export const FilmMetadata = z.object({
  pack: z.string().min(1).max(64),
  scope: FilmScope,
  production: FilmProduction,
  boards: z.array(ShotBoard).max(2000).optional(),
});
export type FilmMetadata = z.infer<typeof FilmMetadata>;

/** The film record of an IR; VALIDATION when the version was not made by a narrative pack. */
export function filmOf(ir: VideoIR): FilmMetadata {
  const parsed = FilmMetadata.safeParse(ir.metadata?.film);
  if (!parsed.success) {
    throw new StudixError("VALIDATION", "This version carries no narrative film record (metadata.film)", {
      retryable: false,
      details: { issues: parsed.error.issues.slice(0, 5) },
      suggestedAction: "Render a version created by the anime or long-form-film workflow.",
    });
  }
  return parsed.data;
}

function filmIr(
  scope: FilmScope,
  scenes: Scene[],
  assets: readonly AssetRef[],
  extra: { captions?: Captions; metadata?: Record<string, unknown> } = {},
): VideoIR {
  const durationMs = scenes.reduce((n, s) => n + s.durationMs, 0);
  return unwrapValidation(
    validateVideoIR({
      schemaVersion: 1,
      title: scope.title,
      language: scope.language,
      format: { aspectRatio: scope.aspectRatio, ...filmFrameSize(scope), fps: FILM_FPS, durationMs },
      assets: [...assets],
      scenes,
      timeline: buildSequentialTimeline(scenes),
      ...(extra.captions ? { captions: extra.captions } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    }),
    "narrative film IR",
  );
}

function scene(id: string, shots: Shot[], notes?: string): Scene {
  let at = 0;
  const placed = shots.map((s) => {
    const shot = { ...s, startMs: at };
    at += s.durationMs;
    return shot;
  });
  return {
    id,
    role: "body",
    durationMs: at,
    shots: placed,
    ...(notes ? { notes: truncateText(notes, 1000) } : {}),
  };
}

const card = (id: string, text: string, durationMs = CARD_MS): Shot => ({
  id,
  type: "text",
  startMs: 0,
  durationMs,
  text: truncateText(text, 500),
});

/** Readable summary of a shot for the review board (tier, class, camera, beat, lines, SFX). */
function shotSummary(scope: FilmScope, shot: FilmScope["scenes"][number]["shots"][number]): string {
  const name = (id: string) => scope.characters.find((c) => c.id === id)?.name ?? id;
  const lines = shot.lines.map((l) => `${name(l.characterId)}: “${l.text}”`).join(" / ");
  return [
    `${shot.tier} · ${shot.renderClass} · ${shot.durationMs / 1000}s · ${shot.camera}`,
    shot.beat,
    lines,
    shot.sfx.length > 0 ? `SFX: ${shot.sfx.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * G0 review board: the bible (logline, world, tone, characters) as cards, then every shot of the beat sheet as
 * a card of its own length, so the reviewer reads the scope at the film's pace. No paid media.
 */
export function bibleBoardIr(scope: FilmScope, metadata?: Record<string, unknown>): VideoIR {
  const bible = scene(
    "board-bible",
    [
      {
        id: "board-title",
        type: "title",
        startMs: 0,
        durationMs: CARD_MS,
        text: truncateText(scope.title, 160),
        subtitle: truncateText(scope.logline, 240),
      },
      card("board-world", `${scope.world}\n\n${scope.tone}`),
      ...scope.characters.map((c) =>
        card(
          `board-${c.id}`.slice(0, 64),
          `${c.name} — ${c.role}\n${c.description}\n${c.anchors.join("; ")}`,
        ),
      ),
    ],
    `Style: ${scope.style.look}. Music: ${scope.music.style}`,
  );
  const beats = scope.scenes.map((sc) =>
    scene(
      sc.id,
      sc.shots.map((shot) => card(shot.id, shotSummary(scope, shot), shot.durationMs)),
      `${sc.title}: ${sc.summary}`,
    ),
  );
  return filmIr(scope, [bible, ...beats], [], metadata ? { metadata } : {});
}

/** G1 review board: every character sheet, then every set frame, one card each. */
export function designBoardIr(
  scope: FilmScope,
  sheets: ReadonlyMap<string, AssetRef>,
  setFrames: ReadonlyMap<string, AssetRef>,
  metadata?: Record<string, unknown>,
): VideoIR {
  const image = (id: string, asset: AssetRef, alt: string): Shot => ({
    id,
    type: "image",
    startMs: 0,
    durationMs: CARD_MS,
    assetId: asset.id,
    alt: truncateText(alt, 300),
    fit: "contain",
  });
  const shots: Shot[] = [
    ...scope.characters.flatMap((c) => {
      const a = sheets.get(c.id);
      return a ? [image(`design-${c.id}`.slice(0, 64), a, `${c.name}: ${c.anchors.join("; ")}`)] : [];
    }),
    ...scope.sets.flatMap((s) => {
      const a = setFrames.get(s.id);
      return a ? [image(`design-${s.id}`.slice(0, 64), a, `${s.description} (${s.light})`)] : [];
    }),
  ];
  if (shots.length === 0)
    throw new StudixError("INTERNAL", "The design board has no designs", { retryable: false });
  return filmIr(scope, [scene("board-designs", shots)], [...sheets.values(), ...setFrames.values()], {
    ...(metadata ? { metadata } : {}),
  });
}

/**
 * Temp captions of the scope's dialogue: each shot's lines share the shot evenly, with a short lead-in.
 * The dialogue stage replaces them with the timing of the recorded lines.
 */
export function tempCaptions(scope: FilmScope): Captions | undefined {
  const cues: Captions["cues"] = [];
  let at = 0;
  for (const { shot } of scopeShots(scope)) {
    const slot = Math.floor(shot.durationMs / Math.max(1, shot.lines.length));
    shot.lines.forEach((line, i) => {
      const startMs = at + i * slot + 150;
      cues.push({
        startMs,
        endMs: Math.max(startMs + 1, at + (i + 1) * slot - 100),
        text: truncateText(line.text, 300),
      });
    });
    at += shot.durationMs;
  }
  return cues.length > 0 ? { language: scope.language, mode: "burned", position: "bottom", cues } : undefined;
}

/**
 * The storyboard of the film (part A's result): one scene per scope scene, one keyframe image shot per scope
 * shot under the shot's own id, temp captions, and the designs kept as assets for conditioning later shots.
 */
export function storyboardIr(
  scope: FilmScope,
  keyframes: ReadonlyMap<string, AssetRef>,
  designs: readonly AssetRef[],
  metadata: FilmMetadata,
): VideoIR {
  const scenes = scope.scenes.map((sc) =>
    scene(
      sc.id,
      sc.shots.map((shot): Shot => {
        const frame = keyframes.get(shot.id);
        if (!frame)
          throw new StudixError("INTERNAL", `No keyframe for shot ${shot.id}`, { retryable: false });
        return {
          id: shot.id,
          type: "image",
          startMs: 0,
          durationMs: shot.durationMs,
          assetId: frame.id,
          alt: truncateText(shot.beat, 300),
          fit: "cover",
        };
      }),
      `${sc.title}: ${sc.summary}`,
    ),
  );
  const ir = filmIr(scope, scenes, [...designs, ...keyframes.values()], {
    ...(tempCaptions(scope) ? { captions: tempCaptions(scope) as Captions } : {}),
    metadata: { film: metadata },
  });
  if (ir.format.durationMs !== scopeDurationMs(scope))
    throw new StudixError("INTERNAL", "Storyboard length differs from the scope", { retryable: false });
  return ir;
}

/** Absolute start of every shot of an IR, by shot id (scenes laid out by the timeline). */
export function shotStarts(ir: VideoIR): Map<string, { startMs: number; durationMs: number }> {
  const sceneStart = new Map(ir.timeline.entries.map((e) => [e.sceneId, e.startMs]));
  const out = new Map<string, { startMs: number; durationMs: number }>();
  for (const sc of ir.scenes) {
    const base = sceneStart.get(sc.id) ?? 0;
    for (const shot of sc.shots)
      out.set(shot.id, { startMs: base + shot.startMs, durationMs: shot.durationMs });
  }
  return out;
}
