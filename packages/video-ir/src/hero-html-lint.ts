import { MotionPreset } from "./shot.ts";

const SVG_CHILDREN = [
  "g",
  "defs",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "text",
  "tspan",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
];
const HTML_TAGS = [
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "small",
  "mark",
  "br",
  "ul",
  "ol",
  "li",
  "figure",
  "figcaption",
  "blockquote",
  "style",
  "svg",
];
const ALLOWED_TAGS = new Set([...HTML_TAGS, ...SVG_CHILDREN]);
/** Blocks a browser would hoist out of an open <p>, silently changing the structure. */
const BLOCKS = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "figure", "blockquote"]);

const ALLOWED_ATTRS = new Set(
  [
    "class",
    "id",
    "style",
    "role",
    "data-enter",
    "data-at",
    "data-duration",
    "viewBox",
    "d",
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
    "points",
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "transform",
    "offset",
    "stop-color",
    "stop-opacity",
    "gradientUnits",
    "gradientTransform",
    "font-size",
    "font-weight",
    "text-anchor",
    "dominant-baseline",
    "preserveAspectRatio",
    "clip-path",
    "mask",
    "xmlns",
  ].map((a) => a.toLowerCase()),
);

const ENTER_PRESETS = MotionPreset.options.filter((p) => p !== "none");
const MAX_ELEMENTS = 300;
const MAX_SECONDS = 30;

/** Decodes numeric and the common named character references, so `&#106;avascript:` is caught. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16) % 0x110000),
    )
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec) % 0x110000))
    .replace(/&(colon|lpar|rpar|sol|bsol|commat|tab|newline);/gi, (_, name: string) => {
      const map: Record<string, string> = {
        colon: ":",
        lpar: "(",
        rpar: ")",
        sol: "/",
        bsol: "\\",
        commat: "@",
        tab: "\t",
        newline: "\n",
      };
      return map[name.toLowerCase()] ?? "";
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** CSS with comments removed and escapes decoded, lower-cased, ready for pattern checks. */
function normalizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, " ")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16) % 0x110000),
    )
    .replace(/\\(.)/g, "$1")
    .toLowerCase();
}

/** Problems shared by CSS (style block and style attributes) and every entity-decoded attribute value. */
function valueProblems(raw: string, where: string, css: boolean): string[] {
  const problems: string[] = [];
  const text = css ? normalizeCss(raw) : raw.toLowerCase();
  const compact = [...text].filter((c) => c > " ").join("");
  if (compact.includes("javascript:")) problems.push(`${where}: "javascript:" is not allowed`);
  if (compact.includes("expression(")) problems.push(`${where}: CSS expression() is not allowed`);
  if (/behavior\s*:/.test(text)) problems.push(`${where}: "behavior:" is not allowed`);
  if (text.includes("-moz-binding")) problems.push(`${where}: -moz-binding is not allowed`);
  if (text.includes("</style")) problems.push(`${where}: "</style" is not allowed`);
  for (const match of text.matchAll(/url\s*\(([^)]*)\)?/g)) {
    if (!/^#[a-z_][\w-]*$/.test(match[1] ?? "") || !match[0].endsWith(")"))
      problems.push(
        `${where}: ${match[0].slice(0, 60)} loads an external resource; only url(#id) references to ids in the card are allowed`,
      );
  }
  if (/(?:image-set|cross-fade|image|element|src)\s*\(/.test(text))
    problems.push(`${where}: image-set(), cross-fade(), image(), element() and src() are not allowed`);
  if (css) {
    const outsideStrings = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    for (const match of outsideStrings.matchAll(/@[a-z-]+/g))
      problems.push(
        `${where}: ${match[0]} is not allowed (no at-rules: no @import, @font-face, @keyframes or @media; animate with data-enter)`,
      );
    // The renderer splits the fragment with plain patterns, so markup characters never appear in the CSS.
    if (outsideStrings.includes("<") || text.includes("<"))
      problems.push(`${where}: "<" is not allowed in CSS`);
    // No CSS nesting: a nested block or "&" could resolve outside the card's scope.
    if (outsideStrings.includes("&")) problems.push(`${where}: "&" (CSS nesting) is not allowed`);
    let depth = 0;
    for (const c of outsideStrings) {
      if (c === "{" && ++depth > 1) {
        problems.push(`${where}: nested rule blocks are not allowed; write flat rules`);
        break;
      }
      if (c === "}") depth = Math.max(0, depth - 1);
    }
    if (/position\s*:\s*fixed/.test(text))
      problems.push(`${where}: position: fixed is not allowed; use absolute positioning inside the card`);
  }
  return problems;
}

/**
 * Structure of the style block, checked on the raw CSS the renderer scopes: the scoper finds rules by their
 * braces, so the block must read the same to it as to a CSS parser.
 */
function styleBlockProblems(raw: string): string[] {
  const where = "<style>";
  const problems: string[] = [];
  if (raw.includes("\\")) problems.push(`${where}: backslash escapes are not allowed`);
  const comments = raw.match(/\/\*/g)?.length ?? 0;
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (css.includes("/*") || (raw.match(/\*\//g)?.length ?? 0) < comments)
    problems.push(`${where}: a CSS comment is not closed with */`);
  const strings = css.match(/"[^"]*"|'[^']*'/g) ?? [];
  if (strings.some((str) => /[{}]/.test(str)))
    problems.push(`${where}: "{" and "}" are not allowed in strings`);
  let depth = 0;
  for (const c of css.replace(/"[^"]*"|'[^']*'/g, '""')) {
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) break;
  }
  if (depth !== 0) problems.push(`${where}: every "{" must be closed by one "}"`);
  return problems;
}

function seconds(value: string): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  const n = Number(value);
  return n >= 0 && n <= MAX_SECONDS ? n : undefined;
}

function attributeProblems(tag: string, name: string, value: string | undefined): string[] {
  const where = `<${tag} ${name}>`;
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return [`${where}: event handlers are not allowed`];
  if (["href", "src", "xlink:href", "srcset", "action", "formaction"].includes(lower))
    return [`${where}: links and external resources are not allowed`];
  if (!ALLOWED_ATTRS.has(lower) && !/^aria-[a-z]+$/.test(lower))
    return [`${where}: attribute "${name}" is not allowed`];
  const v = value ?? "";
  // The renderer re-reads the markup with plain patterns, so attribute values never hold markup characters.
  if (/[<>]/.test(v)) return [`${where}: "<" and ">" are not allowed in attribute values`];
  if (lower === "data-enter" && !(ENTER_PRESETS as string[]).includes(v))
    return [`${where}: "${v}" is not a motion preset; use one of ${ENTER_PRESETS.join(", ")}`];
  if ((lower === "data-at" || lower === "data-duration") && seconds(v) === undefined)
    return [`${where}: "${v}" must be seconds as a plain number from 0 to ${MAX_SECONDS}`];
  if (lower === "id" && !/^[A-Za-z][\w-]{0,63}$/.test(v))
    return [`${where}: "${v}" must start with a letter and contain only letters, digits, - and _`];
  return valueProblems(decodeEntities(v), where, lower === "style");
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

/**
 * Lints the markup of an `html` hero card. The fragment is plain HTML and inline SVG from a small allowlist,
 * styled by at most one `<style>` block (scoped to the card by the renderer) and animated by `data-enter`
 * (a MotionPreset), `data-at` and `data-duration` (seconds after the shot starts). No scripts, links,
 * external resources, comments, at-rules, CSS nesting or fixed positioning. Pure and DOM-free; returns problems an agent can act
 * on, empty when the fragment is clean.
 */
export function lintHeroHtml(html: string): string[] {
  const problems: string[] = [];
  const add = (p: string) => {
    if (!problems.includes(p)) problems.push(p);
  };
  const stack: { tag: string; svg: boolean }[] = [];
  const ids = new Set<string>();
  let elements = 0;
  let styles = 0;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (html.startsWith("<!--", i)) {
      add("HTML comments are not allowed");
      const end = html.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const close = /^<\/([A-Za-z][\w-]*)\s*>/.exec(html.slice(i, i + 80));
    if (close) {
      const tag = close[1]!.toLowerCase();
      const top = stack.at(-1);
      if (!top) add(`</${tag}> closes nothing`);
      else if (top.tag !== tag) {
        add(`</${tag}> found where </${top.tag}> was expected; close every element in order`);
        const at = stack.findLastIndex((e) => e.tag === tag);
        if (at >= 0) stack.length = at;
      } else stack.pop();
      i += close[0].length;
      continue;
    }
    const open = /^<([A-Za-z][\w-]*)/.exec(html.slice(i, i + 80));
    if (!open) {
      if (/^<[!?/]/.test(html.slice(i, i + 2))) {
        add(`"${html.slice(i, i + 20)}" is not allowed markup`);
        const gt = html.indexOf(">", i);
        i = gt < 0 ? html.length : gt + 1;
      } else i += 1; // a lone "<" in text
      continue;
    }
    const rawTag = open[1]!;
    const tag = rawTag.toLowerCase();
    i += open[0].length;
    // Attributes, up to ">" or "/>".
    const attrs: { name: string; value: string | undefined }[] = [];
    let selfClosing = false;
    let ended = false;
    while (i < html.length) {
      while (/\s/.test(html[i] ?? "")) i++;
      if (html[i] === ">") {
        i++;
        ended = true;
        break;
      }
      if (html.startsWith("/>", i)) {
        i += 2;
        selfClosing = true;
        ended = true;
        break;
      }
      ATTR.lastIndex = i;
      const m = ATTR.exec(html);
      if (!m || m[0].length === 0) break;
      attrs.push({ name: m[1]!, value: m[2] ?? m[3] ?? m[4] });
      i = ATTR.lastIndex;
    }
    if (!ended) {
      add(`<${rawTag}> is not closed with ">" or has a malformed attribute`);
      break;
    }

    elements++;
    const parent = stack.at(-1);
    const inSvg = parent?.svg ?? false;
    if (!ALLOWED_TAGS.has(tag)) {
      add(`<${tag}> is not allowed (use div, span, p, h1-h6, lists, figure, blockquote, inline SVG shapes)`);
    } else if (SVG_CHILDREN.includes(tag) && !inSvg) {
      add(`<${tag}> must be inside an <svg>`);
    } else if (inSvg && !SVG_CHILDREN.includes(tag) && tag !== "style") {
      add(`<${tag}> is not allowed inside an <svg>`);
    }
    if (parent?.tag === "p" && BLOCKS.has(tag)) add(`<${tag}> cannot be inside a <p>; use a <div> or <span>`);
    for (const { name, value } of attrs) {
      for (const p of attributeProblems(tag, name, value)) add(p);
      if (name.toLowerCase() === "id" && value) {
        if (ids.has(value)) add(`id "${value}" is used twice`);
        ids.add(value);
      }
    }

    if (tag === "style") {
      if (++styles > 1) add("only one <style> block is allowed");
      const end = html.toLowerCase().indexOf("</style", i);
      if (end < 0) {
        add("<style> is not closed with </style>");
        break;
      }
      for (const p of [
        ...styleBlockProblems(html.slice(i, end)),
        ...valueProblems(html.slice(i, end), "<style>", true),
      ])
        add(p);
      const closeTag = /^<\/style\s*>/i.exec(html.slice(end, end + 20));
      if (!closeTag) {
        add("</style is malformed");
        break;
      }
      i = end + closeTag[0].length;
      continue;
    }
    const svg = inSvg || tag === "svg";
    if (tag === "br") continue;
    if (selfClosing) {
      if (!svg) add(`<${tag}/> does not self-close in HTML; write <${tag}></${tag}>`);
      continue;
    }
    stack.push({ tag, svg });
  }

  for (const open of stack.reverse()) add(`<${open.tag}> is never closed`);
  if (elements > MAX_ELEMENTS) add(`${elements} elements; a hero card may have at most ${MAX_ELEMENTS}`);
  return problems;
}
