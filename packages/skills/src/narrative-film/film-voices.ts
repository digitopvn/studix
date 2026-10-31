import { StudixError } from "@studix/shared";
import type { FilmProduction } from "@studix/video-ir";
import { MAX_VOICE_DIRECTION_CHARS } from "../voice-direction.ts";
import { type FilmScope, lineId, scopeShots, VOICE_REF } from "./film-scope.ts";

/**
 * Voice casting and line direction of a narrative film. Every speaking character is cast once in the bible
 * (`voice.voiceRef`), so the same character sounds the same in every shot, and every line is read with
 * direction built from the character's voice and the line's delivery.
 */

/** Speech model and voice of one character; an absent field falls back to the provider's route. */
export interface FilmVoice {
  /** `<vendor>:<model>` the line is spoken with; the language route's model when absent. */
  model?: string;
  /** Voice id of that model; the route's voice when absent. */
  voice?: string;
}

/**
 * Parse a bible `voiceRef`: `<voice>`, `<vendor>:<model>` or `<vendor>:<model>@<voice>`, e.g.
 * `openrouter:google/gemini-3.8-flash-tts@Leda`. A model without a voice list (Fish Audio Drama) is cast by
 * model alone. Throws VALIDATION on anything else, before a paid call.
 */
export function parseVoiceRef(ref: string, characterId: string): FilmVoice {
  if (!VOICE_REF.test(ref)) {
    throw new StudixError("VALIDATION", `Voice of ${characterId} must read [<vendor>:<model>][@<voice>]`, {
      retryable: false,
      details: { characterId, voiceRef: ref },
    });
  }
  if (!ref.includes(":")) return { voice: ref };
  const at = ref.lastIndexOf("@");
  return at === -1 ? { model: ref } : { model: ref.slice(0, at), voice: ref.slice(at + 1) };
}

/**
 * The voice of every character who speaks a line, from the bible. Two speakers who would sound the same
 * (the same model and voice, or both left to the provider's default) fail with VALIDATION before any line
 * is recorded: each character keeps one voice of its own across the film.
 */
export function filmVoiceCast(production: FilmProduction): Map<string, FilmVoice> {
  const speakers = [...new Set(production.dialogue.map((cue) => cue.characterId))];
  const cast = new Map<string, FilmVoice>();
  const taken = new Map<string, string>();
  for (const characterId of speakers) {
    const ref = production.characters.find((c) => c.characterId === characterId)?.voice?.voiceRef;
    const voice = ref ? parseVoiceRef(ref, characterId) : {};
    const key = `${voice.model ?? ""}@${voice.voice ?? ""}`;
    const other = taken.get(key);
    if (other !== undefined) {
      throw new StudixError("VALIDATION", `${other} and ${characterId} would speak with the same voice`, {
        retryable: false,
        details: { characters: [other, characterId], voice },
        suggestedAction:
          "Cast each speaking character a voice of its own in the bible: set " +
          "metadata.film.production.characters[].voice.voiceRef to <vendor>:<model>@<voice>, e.g. " +
          "openrouter:google/gemini-3.8-flash-tts@Leda, then render again.",
      });
    }
    taken.set(key, characterId);
    cast.set(characterId, voice);
  }
  return cast;
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * Direction of one dialogue line: who speaks (the character's voice direction), how this line is read (its
 * delivery), what happens in the shot and the film's tone. Pure, so a stage's cache key may include it.
 */
export function lineDirection(
  scope: FilmScope,
  production: FilmProduction,
  cue: FilmProduction["dialogue"][number],
): string {
  const placed = scopeShots(scope).find(({ shot }) => shot.id === cue.shotId);
  const shot = placed?.shot;
  const line = shot?.lines.find((_, i) => lineId(shot.id, i) === cue.id);
  const character = scope.characters.find((c) => c.id === cue.characterId);
  const bible = production.characters.find((c) => c.characterId === cue.characterId);
  const voice = bible?.voice?.direction ?? character?.voice.direction;
  const language = bible?.voice?.language ?? character?.voice.language ?? scope.language;
  return (
    [
      `${character?.name ?? cue.characterId} speaks one line in a ${languageName(language)} animated film, voiced by a native speaker acting the part.`,
      voice ? `Character voice: ${voice}.` : undefined,
      line?.delivery ? `Read this line: ${line.delivery}.` : undefined,
      shot ? `In the shot: ${shot.beat}.` : undefined,
      placed ? `Scene: ${placed.scene.summary}.` : undefined,
      `Film tone: ${scope.tone}.`,
      "Sound like a real person in the moment, never flat, monotone or robotic; natural pace and breath.",
    ]
      .filter((p): p is string => p !== undefined)
      .join(" ")
      // Scope text is free text; speech routes refuse control characters in direction.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .slice(0, MAX_VOICE_DIRECTION_CHARS)
  );
}
