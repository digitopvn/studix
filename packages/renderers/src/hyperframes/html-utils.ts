// Ported from motion-mcp packages/hyperframes-adapter/src/util.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).

/**
 * HTML-escape text and attribute values; every piece of user text passes through here. `(` and `:` become
 * character references too: the HyperFrames compiler scans the raw page string for `url(...)` (and fetches
 * or copies what it finds), and it does not decode entities, so user text can never read as a URL to it.
 * The browser decodes both, so the rendered text is unchanged.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\(/g, "&#40;")
    .replace(/:/g, "&#58;");
}

/** Deterministic number formatting for HTML/JS output (max 3 decimals, no `-0`). */
export function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Integer-ms IR time to seconds for HyperFrames/GSAP. */
export function seconds(ms: number): number {
  return Number(num(ms / 1000));
}

/** Locale-independent string comparison for stable sorting. */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON for embedding inside an inline `<script>`: `<` is escaped so `</script>` can never appear. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** One CSS rule with one declaration per line. */
export function cssRule(selector: string, declarations: string[]): string {
  return `${selector} {\n${declarations.map((d) => `  ${d}`).join("\n")}\n}`;
}

export function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}
