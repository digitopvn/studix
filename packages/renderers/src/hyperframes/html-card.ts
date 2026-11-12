import type { ChildNode } from "domhandler";
import { parseDocument } from "htmlparser2";
import postcss, { CssSyntaxError, type Declaration, type Root } from "postcss";
import { z } from "zod";
import { escapeHtml } from "./html-utils.ts";

/**
 * HTML card: an agent-authored full-frame card stored as a `code` asset and placed by a composition shot.
 * The card is data only: markup and CSS checked against allowlists and re-serialized by Studix, plus a list
 * of declarative tweens Studix turns into GSAP calls. No agent-written code ever runs.
 *
 * This module depends only on zod and the HTML and CSS parsers (no browser or renderer), so planners can
 * validate cards cheaply.
 */

export const HTML_CARD_MIME = "application/vnd.studix.html-card+json";
export const HTML_CARD_FORMAT = "studix.html-card";
export const HTML_CARD_LIMITS = { htmlChars: 16_000, cssChars: 12_000, tweens: 40 } as const;

export const HTML_CARD_EASES = [
  "none",
  "power1.out",
  "power2.out",
  "power3.out",
  "power4.out",
  "power2.inOut",
  "power3.inOut",
  "expo.out",
  "expo.inOut",
  "back.out(1.4)",
  "sine.inOut",
  "circ.out",
] as const;

const bounded = (limit: number) => z.number().min(-limit).max(limit);

/** Transform, opacity and SVG stroke-draw properties only: GPU-friendly and seek-safe. */
export const TweenProps = z
  .object({
    x: bounded(10_000),
    y: bounded(10_000),
    xPercent: bounded(1_000),
    yPercent: bounded(1_000),
    scale: bounded(20),
    scaleX: bounded(20),
    scaleY: bounded(20),
    rotation: bounded(3_600),
    skewX: bounded(89),
    skewY: bounded(89),
    opacity: z.number().min(0).max(1),
    strokeDashoffset: bounded(100_000),
  })
  .partial()
  .strict();
export type TweenProps = z.infer<typeof TweenProps>;

/**
 * One tween on the card's own timeline. `target` is a simple selector resolved inside the card (ids are
 * the ones written in `html`); `at` is seconds from the card start.
 */
export const HtmlCardTween = z
  .object({
    target: z
      .string()
      .max(80)
      .regex(
        /^[.#]?[A-Za-z][\w-]*(?:[ >][.#]?[A-Za-z][\w-]*){0,3}$/,
        "expected a simple selector such as .title or #ring",
      ),
    at: z.number().min(0).max(60),
    duration: z.number().min(0).max(10),
    from: TweenProps.optional(),
    to: TweenProps.optional(),
    ease: z.enum(HTML_CARD_EASES).optional(),
    stagger: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((t) => t.from !== undefined || t.to !== undefined, { message: "a tween needs from, to or both" });
export type HtmlCardTween = z.infer<typeof HtmlCardTween>;

export const HtmlCardPackage = z
  .object({
    format: z.literal(HTML_CARD_FORMAT),
    version: z.literal(1),
    /** Card markup from the tag and attribute allowlist (HTML text elements and inline SVG). */
    html: z.string().min(1).max(HTML_CARD_LIMITS.htmlChars),
    /** Plain style rules (no at-rules); every selector is scoped to the card, bare declarations style the card. */
    css: z.string().max(HTML_CARD_LIMITS.cssChars),
    tweens: z.array(HtmlCardTween).max(HTML_CARD_LIMITS.tweens),
  })
  .strict();
export type HtmlCardPackage = z.infer<typeof HtmlCardPackage>;

// ---------------------------------------------------------------------------------------------------------
// HTML allowlist

const HTML_TAGS = [
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "strong",
  "em",
  "b",
  "i",
  "br",
  "ul",
  "ol",
  "li",
  "svg",
];
const SVG_TAGS = [
  "g",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "text",
  "tspan",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
];
/** Elements that may hold only inline content; anything else would be re-parented by the browser. */
const INLINE_ONLY = new Set(["p", "h1", "h2", "h3", "span", "strong", "em", "b", "i"]);
const INLINE = new Set(["span", "strong", "em", "b", "i", "br", "svg"]);
const ATTRIBUTES = [
  "class",
  "id",
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
  "dx",
  "dy",
  "width",
  "height",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "offset",
  "stop-color",
  "stop-opacity",
  "transform",
  "gradientUnits",
  "gradientTransform",
  "clip-path",
  "mask",
  "text-anchor",
  "font-size",
  "font-weight",
  "dominant-baseline",
  "preserveAspectRatio",
  "xmlns",
  "aria-hidden",
  "role",
];
const canonical = (names: readonly string[]) => new Map(names.map((n) => [n.toLowerCase(), n]));
const HTML_TAG_NAMES = canonical(HTML_TAGS);
const SVG_TAG_NAMES = canonical(SVG_TAGS);
const ATTRIBUTE_NAMES = canonical(ATTRIBUTES);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const ID = /^[A-Za-z][\w-]*$/;
const FRAGMENT_URL = /url\(\s*(["']?)#([A-Za-z][\w-]*)\1\s*\)/gi;
const ANY_URL = /url\(/gi;
/**
 * Attribute values (geometry, paint, transforms) may hold only these characters: no `\\` (a CSS escape),
 * no `:`, `/` or quotes, so no URL or string can be spelled. Chrome parses paint attributes as CSS.
 */
const ATTRIBUTE_VALUE = /^[A-Za-z0-9\s.,%#()+-]*$/;
/** Functions an attribute value may call: paint colours, SVG transforms and `url(#id)`. */
const ATTRIBUTE_FUNCTIONS = new Set([
  "url",
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "translate",
  "rotate",
  "scale",
  "matrix",
  "skewx",
  "skewy",
]);
const CLASS_VALUE = /^[\w\s-]*$/;

/** Why an attribute value is unsafe, or undefined. */
function attributeValueProblem(attr: string, value: string): string | undefined {
  if (attr === "class")
    return CLASS_VALUE.test(value) ? undefined : "html: class names use letters, digits, - and _ only";
  if (!ATTRIBUTE_VALUE.test(value))
    return `html: attribute "${attr}" may hold only numbers, names, colours, transforms and url(#id)`;
  for (const [, fn] of value.matchAll(/([A-Za-z-]*)\s*\(/g)) {
    if (!ATTRIBUTE_FUNCTIONS.has((fn ?? "").toLowerCase()))
      return `html: attribute "${attr}" calls ${fn || "("}(), which is not allowed`;
  }
  return balanced(value) ? undefined : `html: attribute "${attr}" has unbalanced brackets`;
}

/** True when every ( and [ in `value` closes in order. */
function balanced(value: string): boolean {
  const open: string[] = [];
  for (const ch of value) {
    if (ch === "(" || ch === "[") open.push(ch === "(" ? ")" : "]");
    else if ((ch === ")" || ch === "]") && open.pop() !== ch) return false;
  }
  return open.length === 0;
}

/**
 * Text as markup: HTML-escaped, with `(` and `:` as character references too. This is not what keeps the
 * render offline: the producer re-serializes the page, which decodes them, before it scans for URLs. The
 * HyperFrames patches refuse those downloads and copies (docs/RENDERER.md, compile isolation patches).
 */
const escapeText = (text: string) => escapeHtml(text).replace(/\(/g, "&#40;").replace(/:/g, "&#58;");

/** Rewrite `url(#id)` to the card's namespaced id; true when every `url(` in `value` was a fragment. */
function namespaceUrls(value: string, cardId: string): { value: string; ok: boolean } {
  const fragments = value.match(FRAGMENT_URL)?.length ?? 0;
  const all = value.match(ANY_URL)?.length ?? 0;
  return {
    value: value.replace(FRAGMENT_URL, (_m, _q, id: string) => `url(#${cardId}-${id})`),
    ok: fragments === all,
  };
}

/** Rewrite `#id` selectors to the card's namespaced ids. */
export function namespaceSelector(selector: string, cardId: string): string {
  return selector.replace(/#([A-Za-z][\w-]*)/g, (_m, id: string) => `#${cardId}-${id}`);
}

function sanitizeHtml(html: string, cardId: string, problems: Set<string>): string {
  const doc = parseDocument(html, {
    lowerCaseTags: false,
    lowerCaseAttributeNames: false,
    recognizeSelfClosing: true,
  });

  const walk = (nodes: readonly ChildNode[], parent: string | undefined, inSvg: boolean): string =>
    nodes
      .map((node) => {
        if (node.type === "text") return escapeText(node.data);
        if (node.type === "comment") return "";
        if (node.type === "cdata" || node.type === "root" || node.type === "directive") {
          problems.add("html: doctype, CDATA and processing instructions are not allowed");
          return "";
        }
        const name = node.name.toLowerCase();
        const tag = inSvg ? SVG_TAG_NAMES.get(name) : HTML_TAG_NAMES.get(name);
        if (!tag) {
          problems.add(
            HTML_TAG_NAMES.has(name) || SVG_TAG_NAMES.has(name)
              ? `html: <${node.name}> is not allowed ${inSvg ? "inside" : "outside"} <svg>`
              : `html: <${node.name}> is not allowed (cards use text elements and inline SVG only)`,
          );
          return "";
        }
        if (parent && INLINE_ONLY.has(parent) && !INLINE.has(tag))
          problems.add(`html: <${tag}> is not allowed inside <${parent}> (inline content only)`);
        if ((parent === "ul" || parent === "ol") !== (tag === "li"))
          problems.add("html: <li> must sit directly inside <ul> or <ol>, and lists hold only <li>");

        const attrs: string[] = [];
        for (const [rawName, rawValue] of Object.entries(node.attribs)) {
          const attr = ATTRIBUTE_NAMES.get(rawName.toLowerCase());
          if (!attr) {
            problems.add(`html: attribute "${rawName}" is not allowed`);
            continue;
          }
          if (attr === "xmlns") {
            if (rawValue !== SVG_NAMESPACE) problems.add(`html: xmlns must be ${SVG_NAMESPACE}`);
            continue;
          }
          let value = rawValue;
          if (attr === "id") {
            if (!ID.test(value)) {
              problems.add(`html: id "${value}" must be a plain name (letters, digits, - and _)`);
              continue;
            }
            value = `${cardId}-${value}`;
          } else {
            const problem = attributeValueProblem(attr, value);
            if (problem) {
              problems.add(problem);
              continue;
            }
            const urls = namespaceUrls(value, cardId);
            if (!urls.ok) problems.add("html: url(...) may only point at #ids inside the card");
            value = urls.value;
          }
          attrs.push(` ${attr}="${escapeHtml(value)}"`);
        }
        if (tag === "br") return `<br${attrs.join("")} />`;
        return `<${tag}${attrs.join("")}>${walk(node.children, tag, inSvg || tag === "svg")}</${tag}>`;
      })
      .join("");

  return walk(doc.children, undefined, false);
}

// ---------------------------------------------------------------------------------------------------------
// CSS allowlist

const BANNED_PROPERTIES = new Set(["behavior", "-moz-binding"]);
const BANNED_FUNCTIONS = /\b(?:expression|image-set|-webkit-image-set|element)\s*\(/i;
const UNSAFE_SELECTOR_CHARS = /[<{}\\;@/]/;

function sanitizeDeclaration(decl: Declaration, cardId: string, problems: Set<string>): string | undefined {
  const prop = decl.prop;
  if (!/^-{0,2}[A-Za-z][\w-]*$/.test(prop)) {
    problems.add(`css: property "${prop}" is not a plain property name`);
    return undefined;
  }
  if (BANNED_PROPERTIES.has(prop.toLowerCase())) {
    problems.add(`css: ${prop} is not allowed`);
    return undefined;
  }
  if (decl.important) problems.add("css: !important is not allowed");
  if (/[<{}\\]/.test(decl.value)) problems.add(`css: the value of ${prop} contains < { } or \\`);
  // The browser ends a string at a raw newline and then reads the rest of the sheet as one open block.
  if (/[\r\n\f]/.test(decl.value) && /["']/.test(decl.value))
    problems.add(`css: the value of ${prop} breaks a quoted string across lines`);
  if (!balanced(decl.value)) problems.add(`css: the value of ${prop} has unbalanced brackets`);
  if (BANNED_FUNCTIONS.test(decl.value))
    problems.add("css: expression(), image-set() and element() are not allowed");
  const urls = namespaceUrls(decl.value, cardId);
  if (!urls.ok) problems.add("css: url(...) may only point at #ids inside the card");
  return `${prop}: ${urls.value.replace(/\s+/g, " ")};`;
}

function selectorProblem(selector: string): string | undefined {
  if (!selector) return "css: empty selector";
  if (UNSAFE_SELECTOR_CHARS.test(selector)) return `css: selector "${selector}" contains < { } \\ ; @ or /`;
  if (/[\r\n\f]/.test(selector) && /["']/.test(selector))
    return `css: selector "${selector}" breaks a quoted string across lines`;
  if (!balanced(selector)) return `css: selector "${selector}" has unbalanced brackets`;
  if (/^[+~]/.test(selector))
    return `css: selector "${selector}" must not start with + or ~ (it would leave the card)`;
  if (selector.includes("*") || selector.includes("&"))
    return `css: selector "${selector}" must not use * or &`;
  if (/:root\b/i.test(selector) || /(?:^|[\s>+~(,])(?:html|body)(?![\w-])/i.test(selector))
    return `css: selector "${selector}" must not target :root, html or body`;
  return undefined;
}

function sanitizeCss(css: string, cardId: string, problems: Set<string>): string {
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch (err) {
    const reason = err instanceof CssSyntaxError ? `${err.reason} (line ${err.line})` : String(err);
    problems.add(`css: parse error: ${reason}`);
    return "";
  }
  const card: string[] = [];
  const rules: string[] = [];
  for (const node of root.nodes) {
    if (node.type === "comment") continue;
    if (node.type === "atrule") {
      problems.add(`css: @${node.name} is not allowed (no at-rules)`);
      continue;
    }
    if (node.type === "decl") {
      const decl = sanitizeDeclaration(node, cardId, problems);
      if (decl) card.push(`  ${decl}`);
      continue;
    }
    const selectors: string[] = [];
    for (const raw of node.selectors.map((s) => s.trim())) {
      const problem = selectorProblem(raw);
      if (problem) problems.add(problem);
      else selectors.push(`#${cardId} ${namespaceSelector(raw, cardId)}`);
    }
    const decls: string[] = [];
    for (const child of node.nodes) {
      if (child.type === "comment") continue;
      if (child.type !== "decl") {
        problems.add("css: nested rules and at-rules are not allowed");
        continue;
      }
      const decl = sanitizeDeclaration(child, cardId, problems);
      if (decl) decls.push(`  ${decl}`);
    }
    if (selectors.length > 0) rules.push(`${selectors.join(",\n")} {\n${decls.join("\n")}\n}`);
  }
  return [...(card.length > 0 ? [`#${cardId} {\n${card.join("\n")}\n}`] : []), ...rules].join("\n");
}

// ---------------------------------------------------------------------------------------------------------

export interface SanitizedHtmlCard {
  /** Markup re-serialized from the checked tree, ids namespaced as `<cardId>-<id>`. */
  html: string;
  /** CSS re-serialized rule by rule: bare declarations on `#<cardId>`, every selector prefixed with it. */
  css: string;
  /** Every rule the package breaks; the card must not be used unless this is empty. */
  problems: string[];
}

/** Check a card against the allowlists and re-serialize it for the card element `cardId`. */
export function sanitizeHtmlCard(pkg: HtmlCardPackage, cardId: string): SanitizedHtmlCard {
  const problems = new Set<string>();
  const html = sanitizeHtml(pkg.html, cardId, problems);
  const css = sanitizeCss(pkg.css, cardId, problems);
  return { html, css, problems: [...problems] };
}

/** Every allowlist rule the package breaks, as short human/agent-readable sentences; [] when clean. */
export function htmlCardProblems(pkg: HtmlCardPackage): string[] {
  return sanitizeHtmlCard(pkg, "card").problems;
}
