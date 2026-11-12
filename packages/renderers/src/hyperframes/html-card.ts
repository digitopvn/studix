import { z } from "zod";

/**
 * HTML card: an agent-authored full-frame card (HTML + scoped CSS + a GSAP script) stored as a `code` asset
 * and placed by a composition shot. The HyperFrames renderer compiles it inline into the scene composition.
 *
 * This module is dependency-light (zod only) so planners can validate cards without loading the renderer.
 */

export const HTML_CARD_MIME = "application/vnd.studix.html-card+json";
export const HTML_CARD_FORMAT = "studix.html-card";
export const HTML_CARD_LIMITS = { htmlChars: 16_000, cssChars: 12_000, scriptChars: 12_000 } as const;

export const HtmlCardPackage = z
  .object({
    format: z.literal(HTML_CARD_FORMAT),
    version: z.literal(1),
    /** Card markup (no `<style>`/`<script>`); inline SVG is fine. */
    html: z.string().min(1).max(HTML_CARD_LIMITS.htmlChars),
    /** CSS scoped to the card element with native CSS nesting. */
    css: z.string().max(HTML_CARD_LIMITS.cssChars),
    /** Body of `function (tl, root, frame)`: adds GSAP tweens to `tl`, times in seconds from the card start. */
    script: z.string().max(HTML_CARD_LIMITS.scriptChars),
  })
  .strict();
export type HtmlCardPackage = z.infer<typeof HtmlCardPackage>;

interface Rule {
  re: RegExp;
  problem: string;
}

const BLOCKED_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "img",
  "video",
  "audio",
  "source",
  "template",
  "style",
];

/** URL-bearing attributes may only point inside the card (`#id`) or at inline `data:`. */
const URL_ATTRIBUTES = "href|xlink:href|src|srcset|poster|action|formaction|data|background";

/** `url(...)` whose target is not `#fragment` or `data:`. */
const EXTERNAL_CSS_URL = /url\(\s*(?!['"]?\s*(?:#|data:))/i;

const HTML_RULES: Rule[] = [
  ...BLOCKED_TAGS.map((tag) => ({
    re: new RegExp(`<\\s*/?\\s*${tag}\\b`, "i"),
    problem: `html: <${tag}> is not allowed${tag === "style" ? " (put CSS in the css field)" : tag === "script" ? " (put code in the script field)" : " (cards use inline SVG and CSS only)"}`,
  })),
  { re: /<[^>]*\son[a-z]+\s*=/i, problem: "html: inline on* event attributes are not allowed" },
  { re: /javascript\s*:/i, problem: "html: javascript: URLs are not allowed" },
  { re: /\bhttps?:/i, problem: "html: http(s) URLs are not allowed (cards cannot load network resources)" },
  {
    re: /<[^>]*=\s*["']?\s*\/\/|url\(\s*["']?\s*\/\//i,
    problem: "html: protocol-relative // URLs are not allowed",
  },
  {
    re: new RegExp(`<[^>]*\\s(?:${URL_ATTRIBUTES})\\s*=\\s*(?!["']?\\s*(?:#|data:))`, "i"),
    problem: "html: href/src attributes may only point at #fragments or data: URLs",
  },
  { re: EXTERNAL_CSS_URL, problem: "html: url(...) may only point at #fragments or data: URLs" },
];

const CSS_RULES: Rule[] = [
  { re: /@import\b/i, problem: "css: @import is not allowed" },
  {
    re: /@font-face\b/i,
    problem: "css: @font-face is not allowed (use the bundled var(--font-heading) / var(--font-body))",
  },
  { re: EXTERNAL_CSS_URL, problem: "css: url(...) may only point at #fragments or data: URLs" },
  { re: /\bhttps?:|\/\/[a-z0-9.-]+\.[a-z]{2,}/i, problem: "css: http(s) and // URLs are not allowed" },
  { re: /\bexpression\s*\(/i, problem: "css: expression() is not allowed" },
  { re: /<\s*\/?\s*style\b/i, problem: "css: </style> is not allowed" },
];

/** Script rules: case-sensitive JavaScript identifiers on word boundaries to keep false positives low. */
const SCRIPT_RULES: Rule[] = [
  { re: /\bfetch\b/, problem: "script: fetch is not allowed (no network)" },
  { re: /\bXMLHttpRequest\b/, problem: "script: XMLHttpRequest is not allowed (no network)" },
  { re: /\bWebSocket\b/, problem: "script: WebSocket is not allowed (no network)" },
  { re: /\bEventSource\b/, problem: "script: EventSource is not allowed (no network)" },
  { re: /\bimport\b/, problem: "script: import is not allowed" },
  { re: /\brequire\b/, problem: "script: require is not allowed" },
  { re: /\beval\b/, problem: "script: eval is not allowed" },
  { re: /\bFunction\s*\(|\bnew\s+Function\b/, problem: "script: the Function constructor is not allowed" },
  { re: /\bsetTimeout\b/, problem: "script: setTimeout is not allowed (only add tweens to tl)" },
  { re: /\bsetInterval\b/, problem: "script: setInterval is not allowed (only add tweens to tl)" },
  {
    re: /\brequestAnimationFrame\b/,
    problem: "script: requestAnimationFrame is not allowed (only add tweens to tl)",
  },
  {
    re: /\bMath\s*\.\s*random\b/,
    problem: "script: Math.random is not allowed (renders must be deterministic)",
  },
  { re: /\bDate\b/, problem: "script: Date is not allowed (renders must be deterministic)" },
  { re: /\bperformance\s*\./, problem: "script: performance is not allowed (renders must be deterministic)" },
  { re: /\bnavigator\b/, problem: "script: navigator is not allowed" },
  { re: /\blocation\s*[.=[]|\.\s*location\b/, problem: "script: location is not allowed" },
  { re: /\bdocument\s*\.\s*cookie\b/, problem: "script: document.cookie is not allowed" },
  { re: /\blocalStorage\b/, problem: "script: localStorage is not allowed" },
  { re: /\bsessionStorage\b/, problem: "script: sessionStorage is not allowed" },
  { re: /\bindexedDB\b/, problem: "script: indexedDB is not allowed" },
  { re: /\bpostMessage\b/, problem: "script: postMessage is not allowed" },
  { re: /\bwindow\s*\.\s*parent\b/, problem: "script: window.parent is not allowed" },
  { re: /\bwindow\s*\.\s*top\b|(?<![\w$.])top\s*\./, problem: "script: window.top is not allowed" },
  {
    re: /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\s*\.\s*write/,
    problem:
      "script: innerHTML, outerHTML, insertAdjacentHTML and document.write are not allowed (put markup in html)",
  },
  { re: /\bhttps?:/, problem: "script: http(s) URLs are not allowed" },
  { re: /\b__timelines\b/, problem: "script: __timelines is not allowed (only add tweens to tl)" },
  { re: /<\s*\/?\s*script\b|<!--/i, problem: "script: <script>, </script> and <!-- are not allowed" },
];

/**
 * SVG namespace declarations name a URI without loading it; they are dropped before the URL rules run so
 * pasted inline SVG does not trip them.
 */
const SVG_NAMESPACE = /\sxmlns(?::[a-z]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/[^"']*["']/gi;

function check(source: string, rules: readonly Rule[]): string[] {
  return rules.filter((rule) => rule.re.test(source)).map((rule) => rule.problem);
}

/** Every safety/determinism rule the package breaks, as short human/agent-readable sentences; [] when clean. */
export function htmlCardProblems(pkg: HtmlCardPackage): string[] {
  return [
    ...check(pkg.html.replace(SVG_NAMESPACE, ""), HTML_RULES),
    ...check(pkg.css, CSS_RULES),
    ...check(pkg.script, SCRIPT_RULES),
  ];
}
