/**
 * Tolerant JSON parsing for model replies. Models often wrap the value in a markdown fence, add prose
 * around it, or leave small syntax slips (trailing commas, comments, smart quotes). Each step below
 * only runs when the stricter one before it failed, so a valid reply is never altered.
 */

/** Pull a JSON value out of a model reply; throws a SyntaxError naming the problem when it cannot. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  let firstError: unknown;
  for (const candidate of candidatesOf(trimmed)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      firstError ??= error;
    }
    try {
      return JSON.parse(repairJson(candidate));
    } catch {
      // Try the next, looser candidate.
    }
  }
  throw firstError instanceof SyntaxError ? firstError : new SyntaxError("The reply holds no JSON value");
}

/** The text itself, the body of a fenced block, then the span from the first bracket to its last partner. */
function candidatesOf(text: string): string[] {
  const out = [text];
  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenced) out.push(fenced[1]!.trim());
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const close = text[start] === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end > start) out.push(text.slice(start, end + 1));
  }
  return [...new Set(out)];
}

/** Fix minor slips outside string literals: comments, trailing commas and typographic quotes. */
export function repairJson(text: string): string {
  let out = "";
  let inString = false;
  // A string opened with a typographic quote also closes with one; a plain one only with a plain quote.
  let smartOpened = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === "\\") {
        out += ch + (text[++i] ?? "");
      } else if (ch === '"' || (smartOpened && (ch === "\u201c" || ch === "\u201d"))) {
        inString = false;
        out += '"';
      } else out += ch;
      continue;
    }
    if (ch === '"' || ch === "“" || ch === "”") {
      inString = true;
      smartOpened = ch !== '"';
      out += '"';
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === ",") {
      const next = /^\s*([}\]])/.exec(text.slice(i + 1));
      if (next) continue;
    }
    out += ch;
  }
  return out;
}
