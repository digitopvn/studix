import type { AudioTrack, CaptionCue, Shot, ShotLayout, VideoIR } from "@studix/video-ir";
import { resolveSceneSpans } from "@studix/video-ir";
import { chunkCaption, spokenLength } from "../caption-chunks.ts";
import { VO_PAD_MS } from "../marketing-video/marketing-script.ts";

/** One spoken word and when it is heard, in ms. */
export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** The words of one card's voice-over line on the graphic's timeline. */
export interface CardWords {
  /** Scene id of the card the line is voiced on. */
  card: string;
  words: TimedWord[];
}

/**
 * Where the voice stage keeps the spoken words in the IR metadata, so a later stage that moves the cards
 * (the music stage snapping cuts to beats) knows where the speech is. Renderers ignore metadata.
 */
export const SPOKEN_WORDS_KEY = "spokenWords";

/** A headline enters this long before its first word is heard, so it lands with the word. */
const REVEAL_LEAD_MS = 80;
/** A headline whose first word comes sooner than this after the cut enters with the card. */
const MIN_REVEAL_DELAY_MS = 150;
/** Longest a card stays empty before its headline enters. */
const MAX_REVEAL_DELAY_MS = 700;
/** A layout device starts this long before the word that names it. */
const DEVICE_LEAD_MS = 120;
/** A caption cue stays up this long past its last word when nothing follows it on the card. */
const CAPTION_HOLD_MS = 400;

const splitWords = (text: string) => text.normalize("NFC").trim().split(/\s+/).filter(Boolean);

/**
 * Word timings of a line inside its take, estimated when the provider reported none: the speech span
 * (`startMs`..`endMs` of the file) shared by how long each word takes to say. Deterministic and free.
 */
export function estimateWords(
  text: string,
  span: { startMs: number; endMs: number },
  language?: string,
): TimedWord[] {
  const words = splitWords(text);
  const weights = words.map((w) => Math.max(0.5, spokenLength(w, language)));
  const total = weights.reduce((a, b) => a + b, 0);
  const length = Math.max(0, span.endMs - span.startMs);
  let at = 0;
  return words.map((w, i) => {
    const from = span.startMs + Math.round((length * at) / total);
    at += weights[i] as number;
    const to = span.startMs + Math.round((length * at) / total);
    return { text: w, startMs: from, endMs: Math.max(from + 1, to) };
  });
}

/**
 * Words timed in a take's file, placed where its track plays them: after the track's trim, sped up by its
 * playback rate, and only those heard before the track ends.
 */
export function placeWords(words: readonly TimedWord[], track: AudioTrack): TimedWord[] {
  const trim = track.trimStartMs ?? 0;
  const rate = track.playbackRate ?? 1;
  const end = track.durationMs === undefined ? Number.POSITIVE_INFINITY : track.startMs + track.durationMs;
  const at = (ms: number) => Math.round(track.startMs + Math.max(0, ms - trim) / rate);
  return words
    .map((w) => ({ text: w.text, startMs: at(w.startMs), endMs: Math.max(at(w.startMs) + 1, at(w.endMs)) }))
    .filter((w) => w.startMs < end)
    .map((w) => ({ ...w, endMs: Math.min(w.endMs, end) }))
    .filter((w) => w.endMs > w.startMs);
}

/** The spoken words the voice stage recorded in `ir`; none for a voiceless graphic or an older IR. */
export function spokenWordsOf(ir: VideoIR): CardWords[] {
  const raw = ir.metadata?.[SPOKEN_WORDS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const e = entry as Partial<CardWords> | null;
    if (!e || typeof e.card !== "string" || !Array.isArray(e.words)) return [];
    const words = e.words.filter(
      (w): w is TimedWord =>
        !!w &&
        typeof w.text === "string" &&
        Number.isFinite(w.startMs) &&
        Number.isFinite(w.endMs) &&
        w.endMs > w.startMs,
    );
    return words.length > 0 ? [{ card: e.card, words }] : [];
  });
}

/** Lower-case letters and digits of a word, so "Studix," and "studix" match and "1,200+" reads "1200". */
const token = (word: string) =>
  word
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
const meaningful = (t: string) => t.length >= 3 || /\d/.test(t);
const tokensOf = (texts: readonly (string | undefined)[]) =>
  new Set(
    texts
      .flatMap((t) => (t ? t.split(/\s+/) : []))
      .map(token)
      .filter(meaningful),
  );

/** The words a layout device puts on screen. */
function deviceTexts(layout: ShotLayout): Array<string | undefined> {
  switch (layout.kind) {
    case "prompt-box":
      return [layout.text];
    case "code":
      return layout.lines;
    case "chips":
      return [layout.source, ...layout.items];
    case "checklist":
      return layout.items.flatMap((i) => [i.text, i.status]);
    case "counter":
      return [layout.value, layout.label];
    case "cards-row":
      return layout.items;
    case "swatches":
      return layout.colors.map((c) => c.label);
    case "stat":
      return [layout.value, layout.label];
  }
}

/**
 * The spoken word that names what a device shows: the first one that matches the device's own words and
 * is not part of the headline, else the first that matches at all. Undefined when the line never names it.
 */
function namingWord(
  words: readonly TimedWord[],
  layout: ShotLayout,
  headline: string,
): TimedWord | undefined {
  const device = tokensOf(deviceTexts(layout));
  const head = tokensOf([headline]);
  const hits = words.filter((w) => device.has(token(w.text)));
  return hits.find((w) => !head.has(token(w.text))) ?? hits[0];
}

/** The headline shot of a card: the CTA text on the call to action, else the card's title or text shot. */
const isHeadline = (shot: Shot) =>
  shot.id === "cta-text" || (shot.type !== "logo" && shot.id.endsWith("-text"));

/**
 * A card's captions timed to its words: the line split into the same chunks as before, each cue from its
 * first word to the next cue's first word, the last held a little past its last word (never past `endMs`).
 * Undefined when the words do not match the line's text one to one (the estimated cues are kept).
 */
function cuesFromWords(text: string, words: readonly TimedWord[], endMs: number): CaptionCue[] | undefined {
  const chunks = chunkCaption(text);
  const sizes = chunks.map((c) => splitWords(c).length);
  if (sizes.reduce((a, b) => a + b, 0) !== words.length || words.length === 0) return undefined;
  const cues: CaptionCue[] = [];
  let first = 0;
  for (const [i, chunk] of chunks.entries()) {
    const size = sizes[i] as number;
    const start = (words[first] as TimedWord).startMs;
    const next = words[first + size];
    const last = words[first + size - 1] as TimedWord;
    const end = next ? next.startMs : Math.max(last.endMs, Math.min(endMs, last.endMs + CAPTION_HOLD_MS));
    first += size;
    if (end > start) cues.push({ startMs: start, endMs: end, text: chunk });
  }
  return cues;
}

/**
 * `ir` with what its voice-over says put on the beat of its words: the words recorded in the metadata
 * (`SPOKEN_WORDS_KEY`), each card's headline entering as its first word is heard, each layout device
 * starting its choreography when the line names what it shows (`layoutAtMs`), and the captions cued on
 * the words. A card without words is left as it is.
 */
export function withSpokenWords(
  ir: VideoIR,
  spoken: readonly CardWords[],
  lines: Map<string, string>,
): VideoIR {
  const spans = new Map(resolveSceneSpans(ir.timeline, ir.scenes).map((sp) => [sp.sceneId, sp]));
  const byCard = new Map(spoken.filter((c) => c.words.length > 0).map((c) => [c.card, c.words]));
  const last = ir.scenes.at(-1)?.id;
  let cues = ir.captions?.cues ?? [];
  const scenes = ir.scenes.map((scene) => {
    const words = byCard.get(scene.id);
    const span = spans.get(scene.id);
    if (!words || !span) return scene;
    const text = lines.get(scene.id);
    if (text && ir.captions) {
      const tail = scene.id === last ? VO_PAD_MS : 0;
      const timed = cuesFromWords(text, words, span.endMs - tail);
      if (timed) {
        cues = [...cues.filter((c) => c.startMs < span.startMs || c.startMs >= span.endMs), ...timed].sort(
          (a, b) => a.startMs - b.startMs,
        );
      }
    }
    const firstMs = (words[0] as TimedWord).startMs - span.startMs;
    const delay = firstMs - REVEAL_LEAD_MS;
    const shots = scene.shots.map((shot): Shot => {
      if (!isHeadline(shot)) return shot;
      let next: Shot = shot;
      if (firstMs >= MIN_REVEAL_DELAY_MS) {
        const startMs = Math.min(MAX_REVEAL_DELAY_MS, delay, shot.startMs + shot.durationMs - 500);
        const end = shot.startMs + shot.durationMs;
        if (startMs > 0 && startMs !== shot.startMs) next = { ...shot, startMs, durationMs: end - startMs };
      }
      if ((next.type === "title" || next.type === "text") && next.layout) {
        const named = namingWord(words, next.layout, next.text);
        if (named) {
          const at = named.startMs - span.startMs - next.startMs - DEVICE_LEAD_MS;
          next = { ...next, layoutAtMs: Math.max(0, Math.min(at, next.durationMs - 1)) };
        }
      }
      return next;
    });
    return { ...scene, shots };
  });
  return {
    ...ir,
    scenes,
    ...(ir.captions && cues.length > 0 ? { captions: { ...ir.captions, cues } } : {}),
    metadata: { ...(ir.metadata ?? {}), [SPOKEN_WORDS_KEY]: spoken },
  };
}
