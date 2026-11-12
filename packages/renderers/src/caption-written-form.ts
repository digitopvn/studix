/**
 * Spoken web addresses in a caption line ("app dot studix dot ai", "studix chấm vn") and their written
 * form ("app.studix.ai"). The voice-over reads an address aloud, so the cue text stays spoken (the voice
 * lines are rebuilt from it); only the burned caption shows the address the viewer would type.
 */

/** Words read as the dot of an address. */
const DOT = /^(?:dot|chấm)$/i;
/** Words read as the slash of a path after an address. */
const SLASH = /^(?:slash|gạch)$/i;
/** One label of a host name or path, as a caption word carries it (letters, digits, inner dashes). */
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;
/** Punctuation a spoken address may end on ("dot ai." ends a sentence). */
const TRAILING = /[.,;:!?…"')\]]+$/u;
/**
 * Top-level domains that mark a single "x dot y" as an address. Two or more dots ("app dot studix dot ai")
 * make an address on their own, so this list only has to cover the short forms.
 */
const TLDS = new Set(
  "ai app co com dev io me net org so tv vn xyz gg sh us uk de jp info biz tech studio design cloud link site online store page".split(
    " ",
  ),
);

const bare = (word: string) => word.normalize("NFC").replace(TRAILING, "");

/**
 * Word ranges `[from, to)` of the spoken addresses in a line split into `words`: a label, then "dot" and a
 * label at least once, then optional "slash" and a label pairs. A run with one dot counts only when it ends
 * on a known top-level domain, so "version two dot five" stays prose. Only the last word of a run may carry
 * trailing punctuation.
 */
export function spokenUrlSpans(words: readonly string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < words.length) {
    const end = addressEnd(words, i);
    if (end === undefined) {
      i += 1;
      continue;
    }
    spans.push([i, end]);
    i = end;
  }
  return spans;
}

/** End of the spoken address starting at `start`, or undefined when none starts there. */
function addressEnd(words: readonly string[], start: number): number | undefined {
  const label = (k: number, last: boolean) => {
    const w = words[k];
    if (w === undefined) return false;
    if (!last && TRAILING.test(w)) return false;
    return LABEL.test(bare(w));
  };
  if (!label(start, true) || TRAILING.test(words[start] as string)) return undefined;
  let k = start + 1;
  let dots = 0;
  // Host: label (dot label)+; a label with trailing punctuation closes the address.
  while (DOT.test(words[k] ?? "") && label(k + 1, true)) {
    dots += 1;
    k += 2;
    if (TRAILING.test(words[k - 1] as string)) break;
  }
  if (dots === 0) return undefined;
  const tld = bare(words[k - 1] as string).toLowerCase();
  if (dots < 2 && !TLDS.has(tld)) return undefined;
  // Path: (slash label)*, unless the host already ended a clause.
  if (!TRAILING.test(words[k - 1] as string)) {
    while (SLASH.test(words[k] ?? "") && label(k + 1, true)) {
      k += 2;
      if (TRAILING.test(words[k - 1] as string)) break;
    }
  }
  return k;
}

/** The written form of the spoken address `words` (a `spokenUrlSpans` range): "app.studix.ai/pricing." */
function writtenAddress(words: readonly string[]): string {
  const last = words.at(-1) as string;
  const tail = TRAILING.exec(last)?.[0] ?? "";
  let out = "";
  for (const [k, word] of words.entries()) {
    if (k % 2 === 1) out += DOT.test(word) ? "." : "/";
    else out += bare(word).toLowerCase();
  }
  return out + tail;
}

/**
 * A caption cue as it is burned: every spoken address in `text` in its written form, everything else
 * (spacing included) untouched.
 */
export function writtenCaptionText(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const spans = spokenUrlSpans(words);
  if (spans.length === 0) return text;
  const out: string[] = [];
  let at = 0;
  for (const [from, to] of spans) {
    out.push(...words.slice(at, from), writtenAddress(words.slice(from, to)));
    at = to;
  }
  out.push(...words.slice(at));
  return out.join(" ");
}
