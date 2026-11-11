import { resolveSceneSpans, type VideoIR } from "@studix/video-ir";
import { MAX_VOICE_SPEEDUP } from "../marketing-video/marketing-script.ts";
import { type SpokenSpan, takeRoomMs, type VoiceLine, voiceTakeFits } from "../voice-lines.ts";

/** A voiced line's take as measured: its file length and, when FFmpeg could read it, its speech. */
export interface TakeLength {
  lengthMs: number | undefined;
  measured?: SpokenSpan;
}

/** Shortest a card without a voice-over line may get: time to read a headline. */
const MIN_SILENT_CARD_MS = 1500;
/** Card needs are rounded up to this step, the step the template cuts cards in. */
const STEP_MS = 100;
/** How much faster each retry of the cut reads the takes, up to `MAX_VOICE_SPEEDUP`. */
const RATE_STEP = 0.01;

const roundUp = (ms: number) => Math.ceil(ms / STEP_MS) * STEP_MS;

/** The card (scene index) each line is spoken on: the one its start falls in. */
function cardsOf(ir: VideoIR, lines: readonly VoiceLine[]): number[] {
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
  if (cards.some((c) => c < 0) || new Set(cards).size !== cards.length) {
    // Lines that do not map one to one onto cards cannot be re-timed card by card.
    return lines.every((line, i) => voiceTakeFits(line, takes[i]?.lengthMs, takes[i]?.measured))
      ? current
      : undefined;
  }
  for (let rate = 1; rate <= MAX_VOICE_SPEEDUP + 1e-9; rate += RATE_STEP) {
    const need = current.map((ms) => Math.min(ms, MIN_SILENT_CARD_MS));
    lines.forEach((line, i) => {
      const card = cards[i] as number;
      const take = takes[i];
      // What the card holds besides its line: the lead-in before the hook, the pad after the CTA.
      const around = (current[card] ?? 0) - line.roomMs;
      const room = take ? takeRoomMs(take.lengthMs, take.measured, rate) : undefined;
      need[card] = roundUp((room ?? line.roomMs) + around);
    });
    const out = share(current, need);
    if (out) return out;
  }
  return undefined;
}
