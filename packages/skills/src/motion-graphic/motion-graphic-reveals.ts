import type { AudioTrack, Scene, Shot, VideoIR } from "@studix/video-ir";
import type { SpokenWord } from "../spoken-words.ts";

/** A reveal starts this long before its word, so the entrance is moving as the word is heard. */
export const REVEAL_LEAD_MS = 120;
/**
 * A headline enters no later than this after its cut, so no card opens on an empty frame while the voice
 * catches up; it enters earlier when its first shared word is heard earlier.
 */
export const HEADLINE_LATEST_MS = 150;
/** A layout enters this long after its headline, so the two do not enter as one. */
const LAYOUT_AFTER_HEADLINE_MS = 300;
/**
 * A layout (the card's device) enters no later than this after its cut, so it is on screen within about
 * 0.6 s and its own motion (a count, a typed line, a pipeline) plays while the voice describes it.
 */
export const LAYOUT_LATEST_MS = 450;

const tokens = (text: string) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 || /\p{N}/u.test(w));

/** Where each word of a take is heard on the timeline (ms), given the track that plays it. */
export function heardWords(words: readonly SpokenWord[], track: AudioTrack): SpokenWord[] {
  const trim = track.trimStartMs ?? 0;
  const rate = track.playbackRate ?? 1;
  const end = track.startMs + (track.durationMs ?? Number.POSITIVE_INFINITY);
  return words.flatMap((w) => {
    if (w.startMs < trim) return [];
    const startMs = Math.round(track.startMs + (w.startMs - trim) / rate);
    const endMs = Math.round(track.startMs + (w.endMs - trim) / rate);
    return startMs < end ? [{ text: w.text, startMs, endMs: Math.max(startMs + 1, endMs) }] : [];
  });
}

function reveal(shot: Shot, startMs: number, cardMs: number): Shot {
  const at = Math.max(0, Math.min(Math.round(startMs), cardMs - 1));
  return at === shot.startMs ? shot : { ...shot, startMs: at, durationMs: cardMs - at };
}

/**
 * A card whose headline and layout are revealed on its spoken words (`words`: card-local ms, in order).
 * The headline (or the CTA line) enters on the first word it shares with the voice, or on the first spoken
 * word, but never later than `HEADLINE_LATEST_MS` after the cut. The layout follows it by
 * `LAYOUT_AFTER_HEADLINE_MS`, never later than `LAYOUT_LATEST_MS`, so a card never holds a bare headline
 * while its device waits for the voice. The opening card's headline stays on from its first frame.
 */
function revealCard(scene: Scene, words: readonly SpokenWord[], opening: boolean): Scene {
  const first = words[0];
  if (!first) return scene;
  const cardMs = scene.durationMs;
  const headline = scene.shots.find((sh) => sh.type === "title" || sh.type === "text" || sh.type === "cta");
  const layout = scene.shots.find((sh) => sh.type === "layout");
  const said = new Set(tokens(headline && "text" in headline ? (headline.text ?? "") : ""));
  const keyWord = words.find((w) => tokens(w.text).some((t) => said.has(t))) ?? first;
  const headlineAt = Math.min(Math.max(0, keyWord.startMs - REVEAL_LEAD_MS), HEADLINE_LATEST_MS);
  const layoutAt = Math.min(headlineAt + LAYOUT_AFTER_HEADLINE_MS, LAYOUT_LATEST_MS);
  return {
    ...scene,
    shots: scene.shots.map((sh) => {
      // The opening frame (a feed's preview and thumbnail) always shows the hook's headline.
      if (sh === headline) return opening ? sh : reveal(sh, headlineAt, cardMs);
      if (sh === layout) return reveal(sh, layoutAt, cardMs);
      return sh;
    }),
  };
}

/**
 * The graphic with each voiced card's headline and layout revealed as its line says them (`revealCard`).
 * `lines` are the voiced lines with their take's words and the track that plays them; cards without a
 * line keep their reveal times.
 */
export function withSpokenReveals(
  ir: VideoIR,
  lines: ReadonlyArray<{ card: number; words: readonly SpokenWord[]; track: AudioTrack }>,
): VideoIR {
  let start = 0;
  const starts = ir.scenes.map((sc) => {
    const at = start;
    start += sc.durationMs;
    return at;
  });
  const byCard = new Map<number, SpokenWord[]>();
  for (const line of lines) {
    const at = starts[line.card];
    if (at === undefined) continue;
    const local = heardWords(line.words, line.track)
      .map((w) => ({ ...w, startMs: w.startMs - at, endMs: w.endMs - at }))
      .filter((w) => w.startMs >= 0 && w.startMs < (ir.scenes[line.card]?.durationMs ?? 0));
    byCard.set(line.card, [...(byCard.get(line.card) ?? []), ...local]);
  }
  return {
    ...ir,
    scenes: ir.scenes.map((sc, i) => {
      const words = byCard.get(i);
      return words ? revealCard(sc, words, i === 0) : sc;
    }),
  };
}
