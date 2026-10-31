import type { FilmScope, FilmScopeShot, ScopeCharacter } from "./film-scope.ts";

/**
 * Prompts compiled from the bible, never written freehand per shot: the style block first, the cast clause
 * (only these characters, each once), the character anchors, an edge margin so limbs and props are not cut,
 * and the negatives. Generators draw what the prompt names, so everything a shot must keep is named.
 */

const NO_TEXT = "no text, no letters, no subtitles, no watermark, no logo";
const MARGIN = "keep 8% margin at every frame edge so no limb or prop is cut";

const avoid = (scope: FilmScope, extra: readonly string[] = []) =>
  `Avoid: ${[...scope.style.negatives, ...extra, NO_TEXT].join(", ")}`;

const palette = (c: Pick<ScopeCharacter, "palette">) =>
  c.palette.length > 0 ? `Palette: ${c.palette.map((p) => `${p.name} ${p.hex}`).join(", ")}` : "";

const join = (parts: ReadonlyArray<string | undefined | false>) =>
  parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join(". ")
    .slice(0, 3_900);

/** A reviewer's change to a redrawn design, placed right after what must stay so both survive. */
const revisionClause = (note: string | undefined) =>
  note ? `Reviewer's correction, apply it exactly: ${note}` : undefined;

/**
 * Model sheet of one character: turnaround and expressions on a plain ground (the identity reference).
 * `revision` is a reviewer's note on a redraw: it is added to the bible's
 * anchors, which still hold.
 */
export function characterSheetPrompt(scope: FilmScope, c: ScopeCharacter, revision?: string): string {
  return join([
    scope.style.look,
    `Character model sheet of ${c.name}, ${c.description}`,
    `Keep exactly: ${c.anchors.join("; ")}`,
    revisionClause(revision),
    palette(c),
    c.handedness ? `${c.handedness}-handed` : undefined,
    "Turnaround of the same character: front, three-quarter and back views, full body, neutral pose, plus three head expressions; plain light grey background, even studio light",
    MARGIN,
    avoid(scope, c.negatives),
  ]);
}

/** Set frame: the location with its light, empty, in real perspective; `revision` as for sheets. */
export function setFramePrompt(scope: FilmScope, set: FilmScope["sets"][number], revision?: string): string {
  return join([
    scope.style.look,
    `Background set: ${set.description}`,
    `Light: ${set.light}`,
    revisionClause(revision),
    "Empty set, no characters, real perspective with depth and a clear ground plane, never flat side-on",
    avoid(scope, ["people", "characters"]),
  ]);
}

/** Cast clause of a shot: only these characters, each exactly once, with their anchors. */
function castClause(scope: FilmScope, shot: FilmScopeShot): string {
  const cast = shot.characters
    .map((id) => scope.characters.find((c) => c.id === id))
    .filter((c): c is ScopeCharacter => c !== undefined);
  if (cast.length === 0) return "No characters in frame";
  return `Cast, each exactly once and no one else: ${cast
    .map(
      (c) =>
        `${c.name} (${c.anchors.slice(0, 4).join(", ")}${c.handedness ? `, ${c.handedness}-handed` : ""})`,
    )
    .join("; ")}`;
}

/** Keyframe of a shot: the board's frame description inside the bible's look, cast and set. */
export function keyframePrompt(
  scope: FilmScope,
  sceneSetId: string,
  shot: FilmScopeShot,
  frame: string,
): string {
  const set = scope.sets.find((s) => s.id === sceneSetId);
  const cast = shot.characters
    .map((id) => scope.characters.find((c) => c.id === id))
    .filter((c): c is ScopeCharacter => c !== undefined);
  return join([
    scope.style.look,
    frame,
    `Camera: ${shot.camera}`,
    castClause(scope, shot),
    set ? `Set: ${set.description}; light: ${set.light}` : undefined,
    shot.characters.length > 0
      ? "feet on the ground with contact shadows; empty hands unless a prop is named"
      : undefined,
    MARGIN,
    avoid(
      scope,
      cast.flatMap((c) => c.negatives),
    ),
  ]);
}

/** Image-to-video prompt: the motion of the board on top of the keyframe, with the same cast discipline. */
export function motionPrompt(scope: FilmScope, shot: FilmScopeShot, motion: string): string {
  return join([
    motion,
    `Camera: ${shot.camera}`,
    castClause(scope, shot),
    shot.visibleSpeakers.length > 0 ? "the speaker talks naturally" : "mouths closed, nobody talks",
    "one continuous shot, no cuts, no new characters",
    avoid(scope),
  ]);
}

/** One instrumental score cue per scene, from the bible's music style and tone and the scene's story. */
export function musicPrompt(
  scope: FilmScope,
  scene: Pick<FilmScope["scenes"][number], "title" | "summary">,
): string {
  return join([
    `Instrumental film score cue, ${scope.music.style}`,
    `Mood: ${scope.tone}`,
    `Scene: ${scene.title}, ${scene.summary}`,
    "no vocals",
  ]);
}
