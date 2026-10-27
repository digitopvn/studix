/**
 * Text helpers for on-screen copy that must survive Vietnamese intact.
 *
 * Invariants: text is only NFC-normalized and whitespace-collapsed, never ASCII-folded or stripped of
 * diacritics; breaks and cuts happen only at spaces (between syllables), or at grapheme boundaries when
 * a single token is too long, so a base letter is never separated from its tone mark.
 */

const VIETNAMESE_LETTERS = /[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹ]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Visible length in grapheme clusters (what a viewer counts as characters). */
export function visibleLength(text: string): number {
  let n = 0;
  for (const _ of graphemes.segment(text)) n++;
  return n;
}

/**
 * NFC first: copy pasted from macOS or some IMEs arrives decomposed (NFD), and fonts shape precomposed
 * Vietnamese glyphs far more reliably than stacked combining marks.
 */
export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Comparison key for de-duplicating copy; keeps diacritics because "ma" and "mà" are different words. */
export function dedupeKey(text: string, language: string): string {
  return normalizeText(text).toLocaleLowerCase(language);
}

/** "vi" when the text contains letters only Vietnamese uses, otherwise "en". */
export function detectLanguage(text: string): "vi" | "en" {
  return VIETNAMESE_LETTERS.test(text.normalize("NFC")) ? "vi" : "en";
}

function sliceGraphemes(text: string, count: number): string {
  let out = "";
  let n = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (n++ >= count) break;
    out += segment;
  }
  return out;
}

/** Shorten to at most `max` graphemes, cutting at the last space that fits and adding an ellipsis. */
export function truncateText(text: string, max: number): string {
  const clean = normalizeText(text);
  if (visibleLength(clean) <= max) return clean;
  const head = sliceGraphemes(clean, max - 1);
  const space = head.lastIndexOf(" ");
  const cut = space >= Math.floor(head.length / 2) ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,.;:!?–—-]+$/u, "")}…`;
}

function wrapAt(words: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && visibleLength(candidate) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const CLAUSE_END = /[,.;:!?…]$/u;
const BARE_NUMBER = /^[\d.,%]+$/u;

/** Cost of ending a line after `word`: clause ends are good places, a bare number before its unit is not. */
function breakCost(word: string, next: string | undefined, avg: number): number {
  if (next === undefined) return 0;
  const weight = (avg / 2) ** 2;
  if (CLAUSE_END.test(word)) return -weight;
  if (BARE_NUMBER.test(word)) return weight;
  return 0;
}

/**
 * Insert explicit line breaks so no line exceeds `maxChars`. Keeps the fewest lines greedy wrapping
 * needs, and among those picks (by a small dynamic program over word gaps) the split with the most even
 * line lengths, preferring breaks after clause punctuation and never stranding a number from its unit
 * when avoidable. A single token longer than `maxChars` keeps its own line; the renderer wraps it as a
 * last resort.
 */
export function breakLines(text: string, maxChars: number): string {
  const clean = normalizeText(text);
  if (visibleLength(clean) <= maxChars) return clean;
  const words = clean.split(" ");
  const lineCount = wrapAt(words, maxChars).length;
  const lengths = words.map(visibleLength);
  const avg = visibleLength(clean) / lineCount;
  const lineLength = (from: number, to: number) =>
    lengths.slice(from, to).reduce((sum, n) => sum + n, 0) + (to - from - 1);

  // best[k][i]: cheapest way to set words[0..i) on exactly k lines; from[k][i] is where line k starts.
  const n = words.length;
  const best = Array.from({ length: lineCount + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from = Array.from({ length: lineCount + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let k = 1; k <= lineCount; k++) {
    for (let i = 1; i <= n; i++) {
      for (let j = i - 1; j >= 0; j--) {
        const len = lineLength(j, i);
        if (len > maxChars && i - j > 1) break;
        const prev = best[k - 1]![j]!;
        if (prev === Infinity) continue;
        const cost = prev + (len - avg) ** 2 + breakCost(words[i - 1]!, words[i], avg);
        if (cost < best[k]![i]!) {
          best[k]![i] = cost;
          from[k]![i] = j;
        }
      }
    }
  }
  if (from[lineCount]![n] === -1) return wrapAt(words, maxChars).join("\n");
  const lines: string[] = [];
  for (let k = lineCount, i = n; k > 0; k--) {
    const j = from[k]![i]!;
    lines.unshift(words.slice(j, i).join(" "));
    i = j;
  }
  return lines.join("\n");
}
