import type { CaptionCue } from "@studix/video-ir";

/** Longest caption cue, in words: a burned caption on a vertical frame stays one or two short lines. */
export const MAX_CAPTION_WORDS = 9;

const CLAUSE_END = /[.,;:!?…]$/;

/**
 * Split a spoken line into caption chunks of at most `maxWords` words. A chunk ends at clause punctuation
 * when one falls inside the limit, so a cue never breaks a short clause in two; Vietnamese words (one
 * syllable each, diacritics intact) are counted like any other whitespace-separated word.
 */
export function chunkCaption(text: string, maxWords = MAX_CAPTION_WORDS): string[] {
  const words = text.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(words.length, start + maxWords);
    if (end < words.length) {
      // Prefer the last clause boundary in the window, unless it would leave a one-word chunk.
      for (let i = end - 1; i > start; i--) {
        if (CLAUSE_END.test(words[i] as string)) {
          end = i + 1;
          break;
        }
      }
    }
    chunks.push(words.slice(start, end).join(" "));
    start = end;
  }
  return chunks;
}

/**
 * Caption cues for one spoken line placed in `[startMs, startMs + durationMs)`: chunked with
 * `chunkCaption` and timed in proportion to each chunk's `spokenLength`, in whole milliseconds.
 */
export function captionCues(
  text: string,
  startMs: number,
  durationMs: number,
  maxWords?: number,
): CaptionCue[] {
  const chunks = chunkCaption(text, maxWords);
  // Timed by how long each chunk takes to say, so a chunk holding "AI-native" stays up while it is read.
  const weights = chunks.map((c) => Math.max(spokenLength(c), 0.1));
  const total = weights.reduce((n, w) => n + w, 0);
  if (chunks.length === 0 || durationMs <= 0) return [];
  const cues: CaptionCue[] = [];
  let words = 0;
  for (const [i, chunk] of chunks.entries()) {
    const from = startMs + Math.round((durationMs * words) / total);
    words += weights[i] ?? 0;
    const to = startMs + Math.round((durationMs * words) / total);
    if (to > from) cues.push({ startMs: from, endMs: to, text: chunk });
  }
  return cues;
}

/** Whitespace-separated word count (a Vietnamese syllable is a word). */
export function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/**
 * A foreign syllable in word-equivalents: an English read runs about 4.5 syllables a second against the
 * three words (Vietnamese syllables) a second the voice-over budgets assume.
 */
const FOREIGN_SYLLABLE = 2 / 3;
const VIETNAMESE_MARK = /[\u0300-\u036f\u0111\u0110]/;
const VOWEL_GROUP = /[aeiouy]+/g;
/** Units read as words of their own after a number: "50%" is "năm mươi phần trăm". */
const UNIT_WORDS: Readonly<Record<string, number>> = { "%": 2, k: 1, tr: 1, đ: 1, vnd: 1, usd: 1, $: 1 };

/** Syllables of an unaccented Latin word part: vowel groups, less a silent final "e" or "ed". */
function syllables(part: string): number {
  const lower = part.toLowerCase();
  let n = lower.match(VOWEL_GROUP)?.length ?? 0;
  if (n > 1 && (/[^aeiouyl]e$/.test(lower) || /[^aeiouytd]ed$/.test(lower))) n -= 1;
  return Math.max(1, n);
}

/**
 * Words a number takes to say: one per digit up to two digits, then about two per non-zero digit (the
 * digit and its place, "hai trăm") and one per thousands group ("nghìn", "triệu"). Errs long, never short.
 */
function numberLength(digits: string): number {
  const n = digits.replace(/^0+(?=\d)/, "");
  if (n.length <= 2) return n.length;
  const nonZero = n.replace(/0/g, "").length;
  return Math.max(1, nonZero * 2) + Math.floor((n.length - 1) / 3);
}

/** Words of one letter-only part. */
function partLength(part: string, vietnamese: boolean, shouting: boolean): number {
  if (VIETNAMESE_MARK.test(part)) return 1;
  // A short capitalised run is spelled out ("AI", "MCP"), unless the whole line is set in capitals.
  if (!shouting && /^[A-Z]{2,5}$/.test(part)) return part.length * FOREIGN_SYLLABLE;
  const n = syllables(part);
  // One unaccented syllable of a Vietnamese line is most likely Vietnamese ("la", "va", "cho").
  return vietnamese && n === 1 ? 1 : n * FOREIGN_SYLLABLE;
}

/**
 * How long a line takes to say, in words of the budget's pace (`VO_WORDS_PER_SECOND`). A Vietnamese
 * syllable is one word, as in `wordCount`. A loanword, brand name or English word counts its syllables at
 * an English pace instead, so "AI-native" weighs what it takes to say, not one word. A line is read as
 * Vietnamese when `language` says so or it carries Vietnamese marks; otherwise every word is English.
 * A number counts what it takes to say (`numberLength`) plus its unit ("50%", "99.000đ", "200k"), an
 * acronym a syllable per letter (not when the whole line is in capitals). Rounded to tenths; for timing, never caption chunking.
 */
export function spokenLength(text: string, language?: string): number {
  const clean = text.normalize("NFD");
  const vietnamese = language?.toLowerCase().startsWith("vi") === true || VIETNAMESE_MARK.test(clean);
  const letters = clean.replace(/[^\p{L}]/gu, "");
  const shouting =
    letters.length > 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  let total = 0;
  for (const token of clean.trim().split(/\s+/)) {
    // Digits (with their thousands separators) are read one word each, then a unit glued to them.
    const digits = token.replace(/(\d)[.,](?=\d)/g, "$1").match(/\d+/g) ?? [];
    total += digits.reduce((n, d) => n + numberLength(d), 0);
    const rest = token.replace(/\d+([.,]\d+)*/g, " ").normalize("NFC");
    for (const raw of rest.split(/[\s\-/_.]+/)) {
      const unit = UNIT_WORDS[raw.toLowerCase()];
      if (digits.length > 0 && unit !== undefined) {
        total += unit;
        continue;
      }
      const part = raw.normalize("NFD").replace(/[^\p{L}\p{M}']/gu, "");
      if (part !== "") total += partLength(part, vietnamese, shouting);
    }
  }
  return Math.round(total * 10) / 10;
}
