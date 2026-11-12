import type { ChildNode } from "domhandler";
import { parseDocument } from "htmlparser2";
import { escapeHtml } from "../html-utils.ts";

/**
 * The brand mark of a director-shell film: `<symbol id="sx-mark">` in the shell, drawn by any scene with
 * `<svg><use href="#sx-mark"/></svg>`. It is the brand kit's logo when there is one, else a small mark the
 * director drew (sanitized here to plain shapes), else a deterministic monogram of the brand's name.
 */

/** Element id of the mark symbol in the shell. */
export const MARK_SYMBOL_ID = "sx-mark";
/** Longest mark SVG the director may send. */
export const MARK_SVG_CHARS = 6000;

/** The mark as the shell embeds it: the symbol markup and, for a logo, the file it shows. */
export interface DirectorMark {
  symbol: string;
  /** A logo image copied into the project: project-relative `dest`, absolute local `source`. */
  copy?: { dest: string; source: string };
}

const SHAPES = new Set(["g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);
const NUMBER_ATTRS = new Set([
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "stroke-width",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
]);
const KEYWORD_ATTRS: Record<string, RegExp> = {
  "stroke-linecap": /^(?:butt|round|square)$/,
  "stroke-linejoin": /^(?:miter|round|bevel)$/,
  "fill-rule": /^(?:nonzero|evenodd)$/,
  "clip-rule": /^(?:nonzero|evenodd)$/,
};
const NUMBER = /^-?\d*\.?\d+(?:e-?\d+)?(?:px|%)?$/i;
const COLOR = /^(?:#[0-9a-f]{3,8}|none|currentcolor)$/i;
/** Path data: commands and numbers only. */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const POINTS = /^[0-9eE.,\s+-]+$/;
const TRANSFORM = /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[-0-9eE.,\s]+\)\s*)+$/;
const VIEWBOX = /^\s*-?\d*\.?\d+(?:[\s,]+-?\d*\.?\d+){3}\s*$/;

/** One attribute as it may appear on a mark shape, or undefined when it is not allowed. */
function safeAttribute(name: string, value: string): string | undefined {
  const v = value.trim();
  if (v.length === 0 || v.length > 4000) return undefined;
  if (NUMBER_ATTRS.has(name)) return NUMBER.test(v) ? v : undefined;
  if (name === "fill" || name === "stroke") return COLOR.test(v) ? v : undefined;
  if (name === "d") return PATH_DATA.test(v) ? v : undefined;
  if (name === "points") return POINTS.test(v) ? v : undefined;
  if (name === "transform") return TRANSFORM.test(v) ? v : undefined;
  const keyword = KEYWORD_ATTRS[name];
  if (keyword) return keyword.test(v) ? v : undefined;
  return undefined;
}

/** Serializes the allowed shapes of `nodes`; every other element, text, attribute and comment is dropped. */
function shapes(nodes: readonly ChildNode[], depth: number, budget: { left: number }): string {
  let out = "";
  for (const node of nodes) {
    if (node.type !== "tag" || budget.left <= 0 || depth > 8) continue;
    const tag = node.name.toLowerCase();
    if (!SHAPES.has(tag)) continue;
    budget.left--;
    const attrs = Object.entries(node.attribs)
      .map(([name, value]) => [name.toLowerCase(), safeAttribute(name.toLowerCase(), value)] as const)
      .filter((a): a is readonly [string, string] => a[1] !== undefined)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join("");
    out +=
      tag === "g"
        ? `<g${attrs}>${shapes(node.children, depth + 1, budget)}</g>`
        : `<${tag}${attrs}></${tag}>`;
  }
  return out;
}

/**
 * The director's mark as a shell symbol: only plain shapes (path, circle, rect, ...) with numeric geometry and
 * hex colours survive, so a mark can neither load nor run anything. Undefined when `svg` is not one `<svg>`
 * with a viewBox and at least one shape.
 */
export function markSymbolFromSvg(svg: string): string | undefined {
  if (svg.length === 0 || svg.length > MARK_SVG_CHARS) return undefined;
  const doc = parseDocument(svg.trim(), { xmlMode: true });
  const roots = doc.children.filter((n) => n.type === "tag");
  const root = roots[0];
  if (roots.length !== 1 || root?.type !== "tag" || root.name.toLowerCase() !== "svg") return undefined;
  const viewBox = Object.entries(root.attribs).find(([k]) => k.toLowerCase() === "viewbox")?.[1];
  if (!viewBox || !VIEWBOX.test(viewBox)) return undefined;
  const body = shapes(root.children, 0, { left: 200 });
  if (!/<(?:path|circle|ellipse|rect|line|polyline|polygon)\b/.test(body)) return undefined;
  return `<symbol id="${MARK_SYMBOL_ID}" viewBox="${escapeHtml(viewBox.trim())}">${body}</symbol>`;
}

/** Up to two initials of a brand name ("Studix" -> "S", "Digital Top" -> "DT"); "S" when it has none. */
export function monogramInitials(name: string): string {
  const words = name
    .normalize("NFC")
    .split(/[\s._/-]+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .filter(Boolean);
  return (words.slice(0, 2).join("") || "S").toLocaleUpperCase();
}

/** A deterministic monogram mark: the brand's initials on a rounded tile in the film's accent. */
export function monogramSymbol(name: string): string {
  const initials = escapeHtml(monogramInitials(name));
  const size = initials.length > 1 ? 44 : 56;
  return (
    `<symbol id="${MARK_SYMBOL_ID}" viewBox="0 0 100 100">` +
    '<rect x="2" y="2" width="96" height="96" rx="26" style="fill: var(--film-accent)"></rect>' +
    `<text x="50" y="50" dy="0.35em" text-anchor="middle" style="fill: var(--bg); font: 800 ${size}px var(--font-heading)">${initials}</text>` +
    "</symbol>"
  );
}

/** The brand kit's logo (copied into the project at `dest`) as the mark symbol, fitted into a square. */
export function logoSymbol(dest: string): string {
  return (
    `<symbol id="${MARK_SYMBOL_ID}" viewBox="0 0 100 100">` +
    `<image href="${escapeHtml(dest)}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"></image>` +
    "</symbol>"
  );
}
