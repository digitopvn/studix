import type { CaptionCue } from "@studix/video-ir";

/** Longest caption cue, in words: a burned caption on a vertical frame stays one or two short lines. */
export const MAX_CAPTION_WORDS = 9;

/** Shortest caption cue on screen: a shorter one flashes past before it can be read. */
export const MIN_CAPTION_MS = 600;

const CLAUSE_END = /[.,;:!?…]$/;

/**
 * Split a spoken line into caption chunks of at most `maxWords` words. A chunk ends at clause punctuation
 * when one falls inside the limit, so a cue never breaks a short clause in two; Vietnamese words (one
 * syllable each, diacritics intact) are counted like any other whitespace-separated word. No chunk after
 * the first is a single word when the limit allows: a one-word tail ("about.") takes the word before it along.
 */
export function chunkCaption(text: string, maxWords = MAX_CAPTION_WORDS): string[] {
  const words = text.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, Math.floor(maxWords));
  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(words.length, start + limit);
    if (end < words.length) {
      // Prefer the last clause boundary in the window, unless it would leave a one-word chunk.
      for (let i = end - 1; i > start; i--) {
        if (CLAUSE_END.test(words[i] as string)) {
          end = i + 1;
          break;
        }
      }
      // A one-word tail would flash alone: hand it this chunk's last word, or take it in when that fits.
      if (words.length - end === 1) {
        if (end - start > 2) end -= 1;
        else if (end - start < limit) end = words.length;
      }
    }
    chunks.push(words.slice(start, end).join(" "));
    start = end;
  }
  return chunks;
}

/**
 * Caption cues for one spoken line placed in `[startMs, startMs + durationMs)`: chunked with
 * `chunkCaption` and timed in proportion to each chunk's `spokenLength`, in whole milliseconds. When that
 * leaves a cue shorter than `MIN_CAPTION_MS` or splits a phone number, the line is cut again by
 * `readableChunks` instead.
 */
export function captionCues(
  text: string,
  startMs: number,
  durationMs: number,
  maxWords = MAX_CAPTION_WORDS,
): CaptionCue[] {
  if (durationMs <= 0) return [];
  const chunks = chunkCaption(text, maxWords);
  if (chunks.length === 0) return [];
  const language = VIETNAMESE_MARK.test(text.normalize("NFD")) ? "vi" : undefined;
  let cues = timeChunks(chunks, startMs, durationMs, language);
  const words = chunks.join(" ").split(" ");
  const inPhone = phoneCuts(words);
  let cut = 0;
  let cutsPhone = false;
  for (const chunk of chunks.slice(0, -1)) {
    cut += wordCount(chunk);
    cutsPhone ||= inPhone.has(cut);
  }
  if (cutsPhone || (cues.length > 1 && cues.some((c) => c.endMs - c.startMs < MIN_CAPTION_MS))) {
    const limit = Math.max(1, Math.floor(maxWords));
    cues = timeChunks(readableChunks(words, durationMs, limit, language), startMs, durationMs, language);
  }
  return cues.filter((c) => c.endMs > c.startMs);
}

/** Times chunks across the span in proportion to how long each takes to say (`spokenLength`). */
function timeChunks(chunks: string[], startMs: number, durationMs: number, language?: string): CaptionCue[] {
  // Timed by how long each chunk takes to say, so a chunk holding "AI-native" stays up while it is read.
  const weights = chunks.map((c) => Math.max(spokenLength(c, language), 0.1));
  const total = weights.reduce((n, w) => n + w, 0);
  let said = 0;
  return chunks.map((text, i) => {
    const from = startMs + Math.round((durationMs * said) / total);
    said += weights[i] ?? 0;
    return { startMs: from, endMs: startMs + Math.round((durationMs * said) / total), text };
  });
}

/**
 * Cuts a line `chunkCaption` cuts badly into chunks of at most `maxWords` words, chosen in order to: keep a
 * phone number in one cue, keep the shortest cue as long as it can be (up to `MIN_CAPTION_MS`), leave no
 * one-word cue, use as few cues as possible, cut at clause ends, then keep cues even. Each chunk is weighed by its own
 * `spokenLength`, as `timeChunks` times it.
 */
function readableChunks(words: string[], durationMs: number, maxWords: number, language?: string): string[] {
  const n = words.length;
  const weight = (i: number, j: number) => Math.max(spokenLength(words.slice(i, j).join(" "), language), 0.1);
  // A little over the minimum: cues are timed against the sum of their own lengths, not the line's.
  const enough = ((MIN_CAPTION_MS * 1.05) / durationMs) * weight(0, n);
  const inPhone = phoneCuts(words);
  // First the longest shortest chunk any cut reaches, capped where every cue is long enough. A cut inside a
  // phone number is taken only when nothing else fits the word limit (its parts would also weigh wrong).
  const longestShortest = (cuttable: (j: number) => boolean) => {
    const floor = new Array<number>(n + 1).fill(-1);
    floor[0] = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= n; j++) {
      if (!cuttable(j)) continue;
      for (let i = Math.max(0, j - maxWords); i < j; i++) {
        if ((floor[i] as number) >= 0)
          floor[j] = Math.max(floor[j] as number, Math.min(floor[i] as number, weight(i, j)));
      }
    }
    return floor[n] as number;
  };
  let cuttable = (j: number) => j === n || !inPhone.has(j);
  let longest = longestShortest(cuttable);
  if (longest < 0) {
    cuttable = () => true;
    longest = longestShortest(cuttable);
  }
  const reach = Math.min(longest, enough) * 0.999;
  // Then, among cuts whose every chunk reaches it, the best by the remaining rules (lower is better).
  type Plan = { cost: [number, number, number, number, number]; from: number };
  const best: (Plan | undefined)[] = [{ cost: [0, 0, 0, 0, 0], from: -1 }];
  const better = (a: Plan["cost"], b: Plan["cost"]) => {
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return (a[k] as number) < (b[k] as number);
    return false;
  };
  for (let j = 1; j <= n; j++) {
    for (let i = Math.max(0, j - maxWords); i < j; i++) {
      const prev = best[i];
      if (!prev || !cuttable(j) || weight(i, j) < reach) continue;
      const cost: Plan["cost"] = [
        prev.cost[0] + (j - i === 1 && n > 1 ? 1 : 0),
        prev.cost[1] + (j < n && inPhone.has(j) ? 1 : 0),
        prev.cost[2] + 1,
        prev.cost[3] + (j < n && !CLAUSE_END.test(words[j - 1] as string) ? 1 : 0),
        prev.cost[4] + weight(i, j) ** 2,
      ];
      const current = best[j];
      if (!current || better(cost, current.cost)) best[j] = { cost, from: i };
    }
  }
  const chunks: string[] = [];
  for (let j = n; j > 0; j = best[j]?.from ?? 0) chunks.unshift(words.slice(best[j]?.from ?? 0, j).join(" "));
  return chunks;
}

/** Word indices `j` where cutting before word `j` splits a phone number ("0901 234 567"). */
function phoneCuts(words: string[]): Set<number> {
  const cuts = new Set<number>();
  const starts: number[] = [];
  let offset = 0;
  for (const w of words) {
    starts.push(offset);
    offset += w.length + 1;
  }
  for (const m of words.join(" ").matchAll(PHONE)) {
    // Only what `spokenLength` reads as a phone number: a leading zero or eight digits and more.
    const digits = m[0].replace(/\D/g, "");
    if (YEAR_RANGE.test(m[0]) || (digits.length < 8 && !digits.startsWith("0"))) continue;
    const from = m.index ?? 0;
    starts.forEach((at, j) => {
      if (at > from && at < from + m[0].length) cuts.add(j);
    });
  }
  return cuts;
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
 * A run with a leading zero (grouped or not), or eight digits and more ungrouped, is a phone number or a
 * code, read a digit at a time.
 */
function numberLength(digits: string, grouped = false): number {
  if (digits.length > 1 && digits.startsWith("0")) return digits.length;
  if (!grouped && digits.length >= 8) return digits.length;
  return amountLength(digits);
}

/** Words an amount takes to say (see `numberLength`). */
function amountLength(digits: string): number {
  if (digits.length <= 2) return digits.length;
  const nonZero = digits.replace(/0/g, "").length;
  return Math.max(1, nonZero * 2) + Math.floor((digits.length - 1) / 3);
}

/**
 * The numbers of one token, in reading order: a hotline written "1900.6868" (a digit at a time), a
 * thousands-grouped amount ("99.000", "1,500,000", "0901.234.567" with its leading zero a phone number), a
 * day and month ("12.12", "11/11") read as two numbers, a decimal ("4,5", "4.9": "bốn phẩy năm"), or a
 * plain run.
 */
const NUMBER =
  /\d{4}\.\d{4}(?!\d)|\d+(?:[.,]\d{3})+(?!\d)|(\d{1,2})[./](\d{1,2})(?!\d)|(\d+),(\d{1,2})(?!\d)|\d+/g;

function numbersLength(token: string): number {
  let total = 0;
  for (const m of token.matchAll(NUMBER)) {
    const [run, day, month, whole, fraction] = m;
    if (day !== undefined && month !== undefined) {
      // A one-digit second part or a percent is a decimal ("4.9 sao", "12.5%"): its "phẩy" is a word too.
      const decimal = month.length === 1 || token.slice((m.index ?? 0) + run.length).startsWith("%");
      total += numberLength(day) + numberLength(month) + (decimal ? 1 : 0);
    } else if (whole !== undefined && fraction !== undefined) {
      total += numberLength(whole) + 1 + fraction.length;
    } else if (/^\d{4}\.\d{4}$/.test(run)) total += 8;
    else total += numberLength(run.replace(/[.,]/g, ""), /[.,]/.test(run));
  }
  return total;
}

/**
 * A phone number written in groups ("0901 234 567", "1900-1234", "+84 901 234 567"): groups of up to four
 * digits split by single spaces or dashes, starting with a zero or eight digits long and more. A pair of
 * years ("2024-2025") is a range, read as two amounts.
 */
const PHONE = /(?<!\d)\+?\d{1,4}(?:[ -]\d{1,4})+(?!\d)/g;
const YEAR_RANGE = /^((?:19|20)\d\d)[ -]((?:19|20)\d\d)$/;

/** Words of one letter-only part. */
function partLength(part: string, vietnamese: boolean, shouting: boolean): number {
  if (VIETNAMESE_MARK.test(part)) return 1;
  // A short capitalised run is spelled out ("AI", "MCP"). In a line set all in capitals only a run that
  // cannot be read as a word is: no vowel ("TV", "HCM") or at most two letters ("AI").
  if (/^[A-Z]{2,5}$/.test(part) && (!shouting || part.length <= 2 || !/[AEIOUY]/.test(part))) {
    return part.length * FOREIGN_SYLLABLE;
  }
  const n = syllables(part);
  // One unaccented syllable of a Vietnamese line is most likely Vietnamese ("la", "va", "cho").
  return vietnamese && n === 1 ? 1 : n * FOREIGN_SYLLABLE;
}

/**
 * How long a line takes to say, in words of the budget's pace (`VO_WORDS_PER_SECOND`). A Vietnamese
 * syllable is one word, as in `wordCount`. A loanword, brand name or English word counts its syllables at
 * an English pace instead, so "AI-native" weighs what it takes to say, not one word. A line is read as
 * Vietnamese when `language` says so or it carries Vietnamese marks; otherwise every word is English.
 * A number counts what it takes to say (`numbersLength`; a phone number a digit at a time) plus its unit
 * ("50%", "99.000đ", "200k"), an acronym a syllable per letter. Rounded to tenths; for timing, never caption chunking.
 */
export function spokenLength(text: string, language?: string): number {
  const clean = text.normalize("NFD");
  const vietnamese = language?.toLowerCase().startsWith("vi") === true || VIETNAMESE_MARK.test(clean);
  const letters = clean.replace(/[^\p{L}]/gu, "");
  const shouting =
    letters.length > 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  let total = 0;
  const read = clean.replace(PHONE, (run) => {
    const years = YEAR_RANGE.exec(run);
    if (years) {
      // "2024-2025": two years and the "đến" between them.
      total += amountLength(years[1] as string) + 1 + amountLength(years[2] as string);
      return " ";
    }
    const digits = run.replace(/\D/g, "");
    if (digits.length < 8 && !digits.startsWith("0")) return run;
    total += digits.length;
    return " ";
  });
  for (const token of read.trim().split(/\s+/)) {
    // Numbers first (`numbersLength`), then a unit glued to them, then the words left.
    const numbers = numbersLength(token);
    total += numbers;
    const rest = token.replace(NUMBER, " ").normalize("NFC");
    for (const raw of rest.split(/[\s\-/_.,]+/)) {
      const unit = UNIT_WORDS[raw.toLowerCase()];
      if (numbers > 0 && unit !== undefined) {
        total += unit;
        continue;
      }
      const part = raw.normalize("NFD").replace(/[^\p{L}\p{M}']/gu, "");
      if (part !== "") total += partLength(part, vietnamese, shouting);
    }
  }
  return Math.round(total * 10) / 10;
}
