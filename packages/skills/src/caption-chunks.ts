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
 * `chunkCaption` and timed in proportion to each chunk's word count, in whole milliseconds.
 */
export function captionCues(
  text: string,
  startMs: number,
  durationMs: number,
  maxWords?: number,
): CaptionCue[] {
  const chunks = chunkCaption(text, maxWords);
  const total = chunks.reduce((n, c) => n + c.split(" ").length, 0);
  if (total === 0 || durationMs <= 0) return [];
  const cues: CaptionCue[] = [];
  let words = 0;
  for (const chunk of chunks) {
    const from = startMs + Math.round((durationMs * words) / total);
    words += chunk.split(" ").length;
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

/** Syllables of an unaccented Latin word part: vowel groups, less a silent final "e" or "ed". */
function syllables(part: string): number {
  const lower = part.toLowerCase();
  let n = lower.match(VOWEL_GROUP)?.length ?? 0;
  if (n > 1 && (/[^aeiouyl]e$/.test(lower) || /[^aeiouytd]ed$/.test(lower))) n -= 1;
  return Math.max(1, n);
}

/**
 * How long a line takes to say, in words of the budget's pace (`VO_WORDS_PER_SECOND`). A Vietnamese
 * syllable is one word, as in `wordCount`. A loanword, brand name or English word counts its syllables at
 * an English pace instead, so "AI-native" weighs what it takes to say, not one word; in a line without any
 * Vietnamese marks every word is English and counts that way. Numbers count a word per digit and an
 * acronym a syllable per letter. Pure; meant for timing, never for caption chunking.
 */
export function spokenLength(text: string): number {
  const clean = text.normalize("NFD");
  const vietnamese = VIETNAMESE_MARK.test(clean);
  let total = 0;
  for (const token of clean.trim().split(/\s+/)) {
    for (const raw of token.split(/[-/_]/)) {
      const part = raw.replace(/[^\p{L}\p{M}\p{N}']/gu, "");
      if (part === "") continue;
      if (/^\p{N}+$/u.test(part)) total += part.length;
      else if (VIETNAMESE_MARK.test(part)) total += 1;
      else if (/^[A-Z]{2,5}$/.test(part)) total += part.length * FOREIGN_SYLLABLE;
      else {
        const n = syllables(part);
        // One unaccented syllable inside a Vietnamese line is most likely Vietnamese ("la", "va", "cho").
        total += vietnamese && n === 1 ? 1 : n * FOREIGN_SYLLABLE;
      }
    }
  }
  return Math.round(total * 10) / 10;
}
