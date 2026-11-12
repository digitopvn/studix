import type { MotionPreset } from "@studix/video-ir";

/**
 * Helpers for `html` hero cards. The markup reaching the renderer already passed lintHeroHtml (enforced by
 * validateVideoIR): balanced allowlisted tags, no comments, no "<" or ">" in attribute values, at most one
 * <style> block without "<", at-rules or nesting, no scripts. These helpers rely on that and stay regex-based.
 */

/** Entrance of one `data-enter` element; times are seconds after the shot starts. */
export interface HeroEntrance {
  /** Document-order index, also the value of the generated `data-hf-e` attribute. */
  index: number;
  preset: Exclude<MotionPreset, "none">;
  atSec: number;
  durationSec: number;
}

/** Defaults for elements that omit data-at / data-duration: staggered in document order. */
export const HERO_FIRST_AT_SEC = 0.15;
export const HERO_STAGGER_SEC = 0.08;
export const HERO_DURATION_SEC = 0.5;
/** Settle time of a hero card without data-enter elements, after the shot starts. */
export const HERO_DEFAULT_SETTLE_MS = 1200;

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/i;
const COMMENT = /<!--[\s\S]*?-->/g;
const OPEN_TAG =
  /<([A-Za-z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) result.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  return result;
}

export interface PreparedHero {
  /** Fragment without its style block and comments; `data-enter` elements carry `data-hf-e="<index>"`. */
  html: string;
  /** The style block's CSS (unscoped), empty when the fragment has none. */
  css: string;
  entrances: HeroEntrance[];
}

/** Splits a hero fragment into markup and CSS and plans its entrances. Deterministic. */
export function prepareHero(fragment: string): PreparedHero {
  const css = STYLE_BLOCK.exec(fragment)?.[1]?.trim() ?? "";
  const entrances: HeroEntrance[] = [];
  const html = fragment
    .replace(COMMENT, "")
    .replace(STYLE_BLOCK, "")
    .replace(OPEN_TAG, (tag: string, name: string, raw: string, slash: string) => {
      const attrs = attributes(raw);
      const preset = attrs.get("data-enter");
      if (!preset || preset === "none") return tag;
      const index = entrances.length;
      const at = Number(attrs.get("data-at"));
      const duration = Number(attrs.get("data-duration"));
      entrances.push({
        index,
        preset: preset as HeroEntrance["preset"],
        atSec:
          attrs.has("data-at") && Number.isFinite(at) ? at : HERO_FIRST_AT_SEC + index * HERO_STAGGER_SEC,
        durationSec: attrs.has("data-duration") && Number.isFinite(duration) ? duration : HERO_DURATION_SEC,
      });
      return `<${name}${raw} data-hf-e="${index}"${slash ? " /" : ""}>`;
    })
    .trim();
  return { html, css, entrances };
}

/** Milliseconds after the shot start when every entrance has finished (default when there are none). */
export function heroSettleMs(entrances: readonly HeroEntrance[]): number {
  if (entrances.length === 0) return HERO_DEFAULT_SETTLE_MS;
  return Math.round(Math.max(...entrances.map((e) => e.atSec + e.durationSec)) * 1000);
}

/** Splits at top-level commas (not inside parentheses, brackets or strings). */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const ROOT_TOKEN = /^(?:html|body|:root|:host)(?![\w-])/i;

/** `.a` -> `root .a`; `:root`, `body > .a`, `:root.dark` keep their relation to the card root itself. */
function scopeSelector(selector: string, root: string): string {
  let rest = selector;
  let matched = false;
  for (let m = ROOT_TOKEN.exec(rest); m; m = ROOT_TOKEN.exec(rest)) {
    matched = true;
    rest = rest.slice(m[0].length);
    const ws = /^\s+/.exec(rest)?.[0] ?? "";
    if (!ws || !ROOT_TOKEN.test(rest.slice(ws.length))) break;
    rest = rest.slice(ws.length);
  }
  if (!matched) return `${root} ${selector}`;
  if (rest === "") return root;
  return /^\s/.test(rest) ? `${root} ${rest.trim()}` : `${root}${rest}`;
}

/**
 * Prefixes every top-level selector of `css` with `root`; `html`, `body`, `:root` and `:host` map to the
 * root itself. The lint rejects nested rule blocks, so every block here is a flat declaration list.
 */
export function scopeCss(css: string, root: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    const selectors = source.slice(i, open);
    let depth = 1;
    let quote = "";
    let j = open + 1;
    for (; j < source.length && depth > 0; j++) {
      const c = source[j]!;
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const block = source.slice(open, j).trim();
    const scoped = splitSelectors(selectors).map((s) => scopeSelector(s, root));
    if (scoped.length > 0) out.push(`${scoped.join(", ")} ${block}`);
    i = j;
  }
  return out.join("\n");
}
