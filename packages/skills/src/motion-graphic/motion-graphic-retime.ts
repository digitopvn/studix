import { buildSequentialTimeline, type Scene, type VideoIR } from "@studix/video-ir";
import { captionCues } from "../caption-chunks.ts";
import { MAX_VOICE_SPEEDUP, type VoiceLine } from "../voice-lines.ts";

/** Cards are cut in these steps, like the template cuts them. */
const STEP_MS = 100;
/** Shortest card a re-time leaves: time for its entrance to play and its words to read. */
const MIN_CARD_MS = 1000;
/** Shortest card a re-time leaves a card without a line: time to read a headline. */
const MIN_SILENT_CARD_MS = 1500;

/** A card as the re-time sees it: its length, the silence its line keeps around it, and its take's speech. */
export interface CardTiming {
  durationMs: number;
  /** The lead-in before the line and the pad after it, kept as they are. Zero for a card without a line. */
  padMs: number;
  /** How long the card's take must be heard; undefined for a card without a line. */
  speechMs?: number;
  /** The take's length is unknown (`speechMs` is the room it has now): the card is never cut shorter. */
  unmeasured?: boolean;
}

const up = (ms: number) => Math.ceil(ms / STEP_MS) * STEP_MS;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * New card lengths for measured takes, in the same total and the same 100ms steps: every card gets what its
 * take needs at a natural pace (with its pads), and the rest of the length is shared in proportion to the
 * cards' current lengths, so a card with a short line gives time to a card with a long one. When the takes do
 * not fit at a natural pace, each card gets what its take needs read up to `MAX_VOICE_SPEEDUP` faster, plus
 * a share of the rest in proportion to what that read saved. Undefined when even that does not fit.
 */
export function retimedCardLengths(cards: readonly CardTiming[], totalMs: number): number[] | undefined {
  if (cards.length === 0) return undefined;
  const natural = cards.map((c) =>
    c.speechMs === undefined
      ? Math.min(c.durationMs, MIN_SILENT_CARD_MS)
      : Math.max(MIN_CARD_MS, up(c.padMs + c.speechMs)),
  );
  const brisk = cards.map((c, i) =>
    c.speechMs === undefined || c.unmeasured
      ? (natural[i] as number)
      : Math.max(MIN_CARD_MS, up(c.padMs + Math.ceil(c.speechMs / MAX_VOICE_SPEEDUP))),
  );
  let base: number[];
  let share: number[];
  if (sum(natural) <= totalMs) {
    base = natural;
    share = cards.map((c) => c.durationMs);
  } else if (sum(brisk) <= totalMs) {
    base = brisk;
    share = natural.map((n, i) => n - (brisk[i] as number));
  } else {
    return undefined;
  }
  const slack = totalMs - sum(base);
  const weight = sum(share) || 1;
  const out = base.map((b, i) => b + Math.floor((slack * (share[i] ?? 0)) / weight / STEP_MS) * STEP_MS);
  const last = out.length - 1;
  out[last] = totalMs - sum(out.slice(0, last));
  return out;
}

/** Where each line sits: its card (by index) and the silence kept before and after it in that card. */
function linePlaces(ir: VideoIR, lines: readonly VoiceLine[]) {
  const starts: number[] = [];
  let at = 0;
  for (const scene of ir.scenes) {
    starts.push(at);
    at += scene.durationMs;
  }
  return lines.map((line) => {
    const card = starts.findLastIndex((start) => start <= line.startMs);
    const start = starts[card] ?? 0;
    const end = start + (ir.scenes[card]?.durationMs ?? 0);
    return { card, leadMs: line.startMs - start, tailMs: end - (line.startMs + line.roomMs) };
  });
}

/** The card timing of each card of a graphic, from its lines and the speech of their takes. */
export function cardTimings(
  ir: VideoIR,
  lines: readonly VoiceLine[],
  speechMs: ReadonlyArray<number | undefined>,
): CardTiming[] | undefined {
  const places = linePlaces(ir, lines);
  const cards: CardTiming[] = ir.scenes.map((scene) => ({ durationMs: scene.durationMs, padMs: 0 }));
  for (const [i, place] of places.entries()) {
    const card = cards[place.card];
    // One line per card, inside it: anything else is not a graphic the template made, so it is not re-timed.
    if (!card || card.speechMs !== undefined || place.leadMs < 0 || place.tailMs < 0) return undefined;
    card.padMs = place.leadMs + place.tailMs;
    // A take of unknown length is held to the room its line has now.
    const measured = speechMs[i];
    card.speechMs = measured ?? lines[i]?.roomMs ?? 0;
    if (measured === undefined) card.unmeasured = true;
  }
  return cards;
}

/** `scene` cut to `durationMs`: shots that ran to its end still do, the others keep their length. */
function resized(scene: Scene, durationMs: number): Scene {
  return {
    ...scene,
    durationMs,
    shots: scene.shots.map((shot) => {
      const startMs = Math.min(shot.startMs, durationMs - 1);
      const toEnd = shot.startMs + shot.durationMs >= scene.durationMs;
      return {
        ...shot,
        startMs,
        durationMs: toEnd ? durationMs - startMs : Math.min(shot.durationMs, durationMs - startMs),
      };
    }),
  };
}

/**
 * A sequential graphic with its cards cut to `lengths`, and its lines where they now fall: each line keeps
 * its lead-in and closing pad within its card, its captions are re-timed over its new room as the template
 * times them, and the timeline is rebuilt. Audio other than the voice-over is left as it is: the pack lays
 * its own sounds again.
 */
export function retimeGraphic(
  ir: VideoIR,
  lines: readonly VoiceLine[],
  lengths: readonly number[],
): { ir: VideoIR; lines: VoiceLine[] } {
  const places = linePlaces(ir, lines);
  const scenes = ir.scenes.map((scene, i) => resized(scene, lengths[i] ?? scene.durationMs));
  const starts: number[] = [];
  let at = 0;
  for (const scene of scenes) {
    starts.push(at);
    at += scene.durationMs;
  }
  const moved = lines.map((line, i) => {
    const place = places[i] as (typeof places)[number];
    const startMs = (starts[place.card] ?? 0) + place.leadMs;
    const roomMs = (scenes[place.card]?.durationMs ?? 0) - place.leadMs - place.tailMs;
    return { ...line, startMs, roomMs };
  });
  const cues = moved.flatMap((line) => captionCues(line.text, line.startMs, line.roomMs));
  return {
    ir: {
      ...ir,
      scenes,
      timeline: { ...ir.timeline, ...buildSequentialTimeline(scenes) },
      ...(ir.captions ? { captions: { ...ir.captions, cues } } : {}),
    },
    lines: moved,
  };
}
