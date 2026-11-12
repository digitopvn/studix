import { resolveSceneSpans, type VideoIR } from "@studix/video-ir";
import { MAX_VOICE_SPEEDUP } from "../marketing-video/marketing-script.ts";
import { type SpokenSpan, takeRoomMs, type VoiceLine } from "../voice-lines.ts";
import { MIN_SILENT_CARD_MS } from "./motion-graphic-template.ts";

/** A voiced line's take as measured: its file length and, when FFmpeg could read it, its speech. */
export interface TakeLength {
  lengthMs: number | undefined;
  measured?: SpokenSpan;
}

/** Shortest a voiced card is cut to (unless it was already shorter): long enough to read its words. */
const MIN_VOICED_CARD_MS = 1000;
/** Spare time is first handed over in this step, so most cards keep the step they were cut in. */
const STEP_MS = 100;
/** How much faster each retry of the cut reads the takes, up to `MAX_VOICE_SPEEDUP`. */
const RATE_STEP = 0.01;

/** The card (scene index) each line is spoken on: the one its start falls in; -1 for none. */
export function cardsOf(ir: VideoIR, lines: readonly VoiceLine[]): number[] {
  const spans = resolveSceneSpans(ir.timeline, ir.scenes);
  return lines.map((line) => {
    const span = spans.find((sp) => line.startMs >= sp.startMs && line.startMs < sp.endMs);
    return span ? ir.scenes.findIndex((sc) => sc.id === span.sceneId) : -1;
  });
}

/**
 * Give each card at least `need`, keeping the total: cards short of their need take the time from the cards
 * with time to spare, each giving in proportion to its spare. Undefined when the needs outrun the total.
 */
function share(current: readonly number[], need: readonly number[]): number[] | undefined {
  const total = current.reduce((a, b) => a + b, 0);
  if (need.reduce((a, b) => a + b, 0) > total) return undefined;
  const out = current.map((ms, i) => Math.max(ms, need[i] ?? 0));
  let owed = out.reduce((a, b) => a + b, 0) - total;
  if (owed === 0) return out;
  const spare = out.map((ms, i) => Math.max(0, ms - (need[i] ?? 0)));
  const spareSum = spare.reduce((a, b) => a + b, 0);
  const asked = owed;
  // In whole steps first, so the cards keep the step they were cut in; the rounding is taken after.
  spare.forEach((ms, i) => {
    const give = Math.min(ms, Math.floor((asked * ms) / spareSum / STEP_MS) * STEP_MS);
    out[i] = (out[i] ?? 0) - give;
    spare[i] = ms - give;
    owed -= give;
  });
  for (const i of spare.map((_, i) => i).sort((a, b) => (spare[b] ?? 0) - (spare[a] ?? 0))) {
    if (owed <= 0) break;
    const give = Math.min(spare[i] ?? 0, owed);
    out[i] = (out[i] ?? 0) - give;
    owed -= give;
  }
  return out;
}

/**
 * New card lengths for takes that do not fit the cards they were voiced for: the total stays the same, and
 * cards whose takes are short give time to cards whose takes run long. Each card first gets the room its
 * take needs read as voiced; when the takes together outrun the graphic that way, they are read a little
 * faster (the same rate for every card, up to `MAX_VOICE_SPEEDUP`). Returns the current lengths when every
 * take already fits its card at its own pace, and undefined when the takes cannot fit the graphic at all.
 * Pure. `lines` and `takes` are the IR's voice lines (`voiceLines`) and their takes, in the same order.
 */
export function retimeCards(
  ir: VideoIR,
  lines: readonly VoiceLine[],
  takes: readonly TakeLength[],
): number[] | undefined {
  const current = ir.scenes.map((sc) => sc.durationMs);
  const natural = lines.every((line, i) => {
    const take = takes[i];
    const room = take ? takeRoomMs(take.lengthMs, take.measured) : undefined;
    return room === undefined || room <= line.roomMs;
  });
  if (natural) return current;
  const cards = cardsOf(ir, lines);
  // Lines that do not map one to one onto cards cannot be re-timed card by card: the cards stay.
  if (cards.some((c) => c < 0) || new Set(cards).size !== cards.length) return current;
  for (let step = 0; ; step++) {
    const rate = Math.min(1 + step * RATE_STEP, MAX_VOICE_SPEEDUP);
    const out = share(current, cardNeeds(ir, lines, takes, cards, rate));
    if (out) return out;
    if (rate >= MAX_VOICE_SPEEDUP) return undefined;
  }
}

/**
 * How long each card must be for its take read at `rate`: no card shorter than its own transition out, nor
 * (unless it already was) than time to read it, and a voiced card long enough for its take plus what it
 * holds besides the line (the lead-in before the hook, the pad after the CTA).
 */
function cardNeeds(
  ir: VideoIR,
  lines: readonly VoiceLine[],
  takes: readonly TakeLength[],
  cards: readonly number[],
  rate: number,
): number[] {
  const current = ir.scenes.map((sc) => sc.durationMs);
  const need = ir.scenes.map((sc, i) =>
    Math.max(
      sc.transitionOut?.durationMs ?? 0,
      Math.min(current[i] ?? 0, cards.includes(i) ? MIN_VOICED_CARD_MS : MIN_SILENT_CARD_MS),
    ),
  );
  lines.forEach((line, i) => {
    const card = cards[i] as number;
    const take = takes[i];
    const around = (current[card] ?? 0) - line.roomMs;
    const room = take ? takeRoomMs(take.lengthMs, take.measured, rate) : undefined;
    need[card] = Math.max(need[card] ?? 0, (room ?? line.roomMs) + around);
  });
  return need;
}

/**
 * The shortest each of `cardMs` (new card lengths for `ir`'s cards, from `retimeCards`) may become: what its
 * take needs read at its own pace, but never less than it already is when it was cut tighter than that (its
 * take is then sped up to fit). Undefined when the lines do not map one to one onto cards.
 */
export function cardMinimums(
  ir: VideoIR,
  lines: readonly VoiceLine[],
  takes: readonly TakeLength[],
  cardMs: readonly number[],
): number[] | undefined {
  const cards = cardsOf(ir, lines);
  if (cards.some((c) => c < 0) || new Set(cards).size !== cards.length) return undefined;
  return cardNeeds(ir, lines, takes, cards, 1).map((need, i) => Math.min(need, cardMs[i] ?? 0));
}

/** Where a music bed's beats fall on the graphic's timeline (ms), from its beat analysis. */
export interface CutGrid {
  beatsMs: readonly number[];
  downbeatsMs: readonly number[];
}

/** A cut moves to a downbeat this close, and the cut into the CTA card (the music's drop) to one twice as far. */
export const DOWNBEAT_SNAP_MS = 400;
/**
 * A cut with no downbeat that close moves to a plain beat this close: half a beat at 120 BPM, so most cuts
 * of a bed at that tempo or faster land on one.
 */
export const BEAT_SNAP_MS = 250;

/**
 * Card lengths whose cuts land on the music: each cut, first to last, moves to the nearest downbeat within
 * `DOWNBEAT_SNAP_MS` (twice that for the last cut, into the CTA card, where the music drops), else to the
 * nearest beat within `BEAT_SNAP_MS`, else stays. A cut only moves where both cards beside it keep at least
 * their `minMs`; the total length never changes. Pure.
 */
export function snapCutsToBeats(
  cardMs: readonly number[],
  minMs: readonly number[],
  grid: CutGrid,
): { cardMs: number[]; snapped: number } {
  const cuts: number[] = [0];
  for (const ms of cardMs) cuts.push((cuts.at(-1) as number) + ms);
  let snapped = 0;
  const last = cuts.length - 2;
  for (let k = 1; k < cuts.length - 1; k++) {
    const before = cuts[k - 1] as number;
    const after = cuts[k + 1] as number;
    const at = cuts[k] as number;
    const fits = (t: number) =>
      t - before >= (minMs[k - 1] ?? 0) && after - t >= (minMs[k] ?? 0) && t > before && t < after;
    const nearest = (times: readonly number[], within: number) =>
      times
        .filter((t) => Math.abs(t - at) <= within && fits(t))
        .sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
    const to =
      nearest(grid.downbeatsMs, k === last ? 2 * DOWNBEAT_SNAP_MS : DOWNBEAT_SNAP_MS) ??
      nearest(grid.beatsMs, BEAT_SNAP_MS);
    if (to === undefined) continue;
    if (to !== at) cuts[k] = Math.round(to);
    snapped++;
  }
  return { cardMs: cuts.slice(1).map((t, i) => t - (cuts[i] as number)), snapped };
}
