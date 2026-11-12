/**
 * The closing card's line split for an end-card lockup: a URL or bare domain in the CTA line is set apart
 * (large, under an accent rule), and a leading "Brand —" is dropped when the card's wordmark already names
 * the brand, so the lockup never says the name twice.
 */

/** A web address: an optional scheme, a dotted host whose last label is letters, and an optional path. */
const URL_RE = /(?<![@\p{L}\p{N}._-])(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:\/[^\s]*)?/giu;

const TLD_RE =
  /\.(?:com|net|org|io|ai|app|dev|co|vn|me|so|gg|tv|xyz|link|site|online|store|shop|studio|design|tech|cloud|digital|info|biz|us|uk|eu|de|fr|jp|sg|asia)(?:\/|[.,;:!?)]*$)/iu;

/** Punctuation and dashes left around the removed parts. */
const EDGE_RE = /^[\s\-–—:|·,.]+|[\s\-–—:|·,]+$/gu;

export interface CtaLine {
  /** What the card says, without the URL (and without the brand name the wordmark shows). */
  text: string;
  /** The URL as written, without a trailing full stop; absent when the line has none. */
  url?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Splits `line` into its words and its URL (the last one when there are several). `brandName` is the name
 * the card's wordmark already shows. A line that is only a URL keeps it as its text.
 */
export function splitCtaLine(line: string, brandName?: string): CtaLine {
  // A bare host counts only with a common top-level domain, so "Node.js" stays a word.
  const matches = [...line.matchAll(URL_RE)].filter((m) => /^https?:\/\//i.test(m[0]) || TLD_RE.test(m[0]));
  const found = matches.at(-1);
  if (!found || found.index === undefined) return { text: line };
  const url = found[0].replace(/[.,;:!?)]+$/u, "");
  let text = `${line.slice(0, found.index)} ${line.slice(found.index + found[0].length)}`
    .replace(/\s+/g, " ")
    .replace(EDGE_RE, "");
  const name = brandName?.trim();
  if (name) {
    const lead = new RegExp(`^${escapeRe(name)}\\s*[-–—:|·]\\s*`, "iu");
    const rest = text.replace(lead, "").replace(EDGE_RE, "");
    if (rest !== "") text = rest;
  }
  return { text: text === "" ? url : text, url };
}

/**
 * The end card's copy: `onScreen` split as splitCtaLine does. A line that is only a URL still gets words, so
 * the card is a lockup (line, rule, URL) and never a bare URL: the first of `fallbacks` (the closing voice-over
 * line, the brief's call to action, its title) that says something besides a URL. With none, the text stays
 * the URL and the card shows the URL alone.
 */
export function ctaCopy(
  onScreen: string,
  fallbacks: ReadonlyArray<string | undefined>,
  brandName?: string,
): CtaLine {
  const said = splitCtaLine(onScreen, brandName);
  if (!said.url || said.text !== said.url) return said;
  for (const line of fallbacks) {
    if (!line?.trim()) continue;
    const alt = splitCtaLine(line.trim(), brandName);
    if (alt.text !== "" && alt.text !== alt.url) return { text: alt.text, url: said.url };
  }
  return said;
}

/** `text` cut to at most `max` characters at a word boundary, never mid-word (a single overlong word is cut). */
export function cutOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const end = head.search(/\s\S*$/);
  return (end > 0 ? head.slice(0, end) : text.slice(0, max)).replace(/[\s,;:–—-]+$/u, "");
}
