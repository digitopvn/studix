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
