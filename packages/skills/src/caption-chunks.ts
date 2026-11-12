import { LEANING_WORDS as LEANING, spokenUrlSpans } from "@studix/renderers";
import type { CaptionCue } from "@studix/video-ir";

/** Longest caption cue, in words: a burned caption on a vertical frame stays one or two short lines. */
export const MAX_CAPTION_WORDS = 9;
/** Shortest caption cue, in words: a lone trailing word ("about.") joins the chunk before it. */
export const MIN_CAPTION_WORDS = 2;
/** Shortest caption cue on screen: a shorter one flashes past unread, so it joins its neighbour. */
export const MIN_CAPTION_MS = 600;

/** A word that ends a sentence: the best place for a cue to end. */
const SENTENCE_END = /[.!?…]["')\]]*$/u;
/** A word that ends a clause (comma, semicolon, colon, dash): the next best place. */
const CLAUSE_END = /[,;:\u2013\u2014]["')\]]*$/u;
/** A lone dash between words ("fast - and cheap") ends a clause too. */
const DASH = /^[-\u2013\u2014]$/u;

/** English words a cue may start on when no punctuation is near: a new phrase opens with them. */
const PHRASE_START = new Set(
  (
    "and or but so because while when where which that who if than as with without through via for " +
    "from to at on in into by over under per about across after before during until"
  ).split(" "),
);

const bare = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * How good a cue end before unit `end` is: 4 after a sentence, 3 after a clause (or before a dash), 2
 * before a word that opens a phrase, 1 anywhere else, 0 after a word that leans on the next one.
 */
function breakScore(units: readonly string[], end: number, english: boolean): number {
  const last = units[end - 1] as string;
  const next = units[end] ?? "";
  if (SENTENCE_END.test(last)) return 4;
  if (CLAUSE_END.test(last) || DASH.test(next)) return 3;
  if (!english) return 1;
  const tail = bare(last.split(" ").at(-1) as string);
  if (LEANING.has(tail)) return 0;
  return PHRASE_START.has(bare(next.split(" ")[0] as string)) ? 2 : 1;
}

/**
 * Where the cue starting at unit `start` ends, inside a window ending at `limit`: the latest sentence end,
 * else the latest clause end (either leaving at least `MIN_CAPTION_WORDS`), else in the window's second half
 * the latest place before a phrase opens, else the latest place not after a leaning word, else the same
 * anywhere in the window. A window with no good place at all ends where it ends.
 */
function phraseEnd(units: readonly string[], start: number, limit: number, english: boolean): number {
  const min = start + Math.min(MIN_CAPTION_WORDS, limit - start);
  const half = start + Math.ceil((limit - start) / 2);
  for (const [floor, score] of [
    [min, 4],
    [min, 3],
    [half, 2],
    [half, 1],
    [min, 2],
    [min, 1],
  ] as const) {
    for (let e = limit; e >= Math.max(floor, start + 1); e--) {
      if (breakScore(units, e, english) >= score) return e;
    }
  }
  return limit;
}

/**
 * Split a spoken line into caption chunks of at most `maxWords` words. A chunk ends at a phrase boundary
 * inside the limit (`phraseEnd`: a sentence end, then a clause end, then before a conjunction or
 * preposition) and, on an English line, never on a word that leans on the next one ("at", "the", "one").
 * Vietnamese words (one syllable each, diacritics intact) are counted like any other whitespace-separated
 * word. A spoken web address ("app dot studix dot ai", `spokenUrlSpans`) is one word that never breaks, as
 * it is burned in its written form. A phone number starts a new chunk rather than break across two, unless
 * that leaves a one-word chunk. A tail shorter than `MIN_CAPTION_WORDS` stays with the chunk before it,
 * which may then run one word over the limit.
 */
export function chunkCaption(text: string, maxWords = MAX_CAPTION_WORDS): string[] {
  maxWords = Math.max(1, Math.floor(maxWords));
  const words = text.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  const english = !VIETNAMESE_MARK.test(text.normalize("NFD"));
  // Units: one per word, except a spoken address, which is one unit of all its words.
  const unitOf: number[] = [];
  const units: string[] = [];
  const urls = spokenUrlSpans(words);
  for (let i = 0; i < words.length; ) {
    const url = urls.find(([a]) => a === i);
    const to = url ? url[1] : i + 1;
    for (let k = i; k < to; k++) unitOf.push(units.length);
    units.push(words.slice(i, to).join(" "));
    i = to;
  }
  const phones = phoneSpans(words).map(([a, b]): [number, number] => [
    unitOf[a] as number,
    (unitOf[b - 1] as number) + 1,
  ]);
  const chunks: string[] = [];
  let start = 0;
  while (start < units.length) {
    let end = Math.min(units.length, start + maxWords);
    if (end < units.length) {
      end = phraseEnd(units, start, end, english);
      // Never cut through a phone number ("0901 234 567"): end before it, unless that leaves one word.
      const from = phones.find(([a, b]) => a < end && end < b)?.[0];
      if (from !== undefined && from - start >= Math.min(MIN_CAPTION_WORDS, maxWords)) end = from;
      // Never leave an orphan word behind: the end of the line rides with this chunk instead.
      if (units.length - end < MIN_CAPTION_WORDS && maxWords >= MIN_CAPTION_WORDS) end = units.length;
    }
    chunks.push(units.slice(start, end).join(" "));
    start = end;
  }
  return chunks;
}

/**
 * Caption cues for one spoken line placed in `[startMs, startMs + durationMs)`: chunked with
 * `chunkCaption` and timed in proportion to each chunk's `spokenLength`, in whole milliseconds. A cue
 * shorter than `MIN_CAPTION_MS` joins its neighbour when the two stay within one word of `maxWords`;
 * otherwise the boundary between them moves so each stays up that long when the span allows.
 */
export function captionCues(
  text: string,
  startMs: number,
  durationMs: number,
  maxWords = MAX_CAPTION_WORDS,
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
  return mergeShortCues(cues, maxWords);
}

/**
 * Gives every cue at least `MIN_CAPTION_MS` where the span allows, keeping it covered end to end: a short
 * cue joins its neighbour when the joined text stays within one word of `maxWords` (the most a chunk may
 * hold), else the neighbours share the time so neither overflows the frame's one or two lines.
 */
function mergeShortCues(cues: CaptionCue[], maxWords: number): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const cue of cues) {
    const prev = out.at(-1);
    if (!prev || (cue.endMs - cue.startMs >= MIN_CAPTION_MS && prev.endMs - prev.startMs >= MIN_CAPTION_MS)) {
      out.push(cue);
    } else if (wordCount(prev.text) + wordCount(cue.text) <= Math.max(1, maxWords) + 1) {
      out[out.length - 1] = { startMs: prev.startMs, endMs: cue.endMs, text: `${prev.text} ${cue.text}` };
    } else {
      const lo = prev.startMs + MIN_CAPTION_MS;
      const hi = cue.endMs - MIN_CAPTION_MS;
      const at =
        lo <= hi ? Math.min(hi, Math.max(lo, cue.startMs)) : Math.round((prev.startMs + cue.endMs) / 2);
      out[out.length - 1] = { ...prev, endMs: at };
      out.push({ ...cue, startMs: at });
    }
  }
  return out;
}

/** Word ranges `[from, to)` of the phone numbers (`isPhoneNumber`) in a line split into `words`. */
function phoneSpans(words: string[]): Array<[number, number]> {
  let offset = 0;
  const starts = words.map((w) => {
    const at = offset;
    offset += w.length + 1;
    return at;
  });
  const wordAt = (char: number) => starts.findLastIndex((at) => at <= char);
  const spans: Array<[number, number]> = [];
  for (const m of words.join(" ").matchAll(PHONE)) {
    const at = m.index ?? 0;
    if (isPhoneNumber(m[0])) spans.push([wordAt(at), wordAt(at + m[0].length - 1) + 1]);
  }
  return spans;
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

/** Whether a `PHONE` run is a phone number, read a digit at a time, rather than a year range or amounts. */
function isPhoneNumber(run: string): boolean {
  if (YEAR_RANGE.test(run)) return false;
  const digits = run.replace(/\D/g, "");
  return digits.length >= 8 || digits.startsWith("0");
}

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
    if (!isPhoneNumber(run)) return run;
    total += run.replace(/\D/g, "").length;
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
