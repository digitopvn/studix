import { transformSync } from "esbuild";
import { parseDocument } from "htmlparser2";
import postcss, { CssSyntaxError, type Root } from "postcss";
import { z } from "zod";

/**
 * Scene fragment: one agent-authored scene of a director-shell composition. The agent writes three parts,
 * the inner markup of the scene's `<section>`, CSS for it and the body of its choreography script; Studix
 * wraps the markup in the section, scopes every CSS rule under the section id and splices the script into a
 * guarded block of the shell (director-shell.ts), where only the shell's helpers are in scope.
 *
 * Fragment scripts run only in the skill sandbox (ADR-0022, ADR-0026), never in the in-worker renderer. The
 * checks here are not that security boundary: they keep a render deterministic and offline (no network, no
 * wall clock, no randomness, no timelines of its own) and reject what would break the shell.
 */

export const SCENE_FRAGMENT_LIMITS = { htmlChars: 24_000, cssChars: 12_000, jsChars: 16_000 } as const;

export const SceneFragment = z
  .object({
    /** Inner markup of the scene's section: HTML and inline SVG, no scripts, styles, media or links. */
    html: z.string().min(1).max(SCENE_FRAGMENT_LIMITS.htmlChars),
    /** Plain rules; every selector is scoped under the scene's section, `:scope` names the section itself. */
    css: z.string().max(SCENE_FRAGMENT_LIMITS.cssChars),
    /** Choreography body run once while the page builds, with `tl`, `sid`, `S`, `t0`, `t1` and the shell helpers. */
    js: z.string().min(1).max(SCENE_FRAGMENT_LIMITS.jsChars),
  })
  .strict();
export type SceneFragment = z.infer<typeof SceneFragment>;

/**
 * Shell helpers a fragment may call, with one line each: the builder's whole API. Times are seconds on the
 * composition timeline; `e` is a selector or an element.
 */
export const SCENE_FRAGMENT_HELPERS: Readonly<Record<string, string>> = {
  tl: "the one paused GSAP timeline: tl.fromTo(e, from, to, at), tl.to, tl.set. Never gsap.to/from/timeline",
  "W(sid, word, nth = 1) / WE(...)":
    "onset / end of a spoken word of this scene (lower-case, no punctuation)",
  "B(n)": "time of quarter note n of the beat grid; isKick(n): beat n is in a loud section",
  "t0 / t1": "this scene's start and end",
  "S / $s(q) / $$s(q)": "the section selector, and querySelector(All) inside it",
  "$(q) / $$(q)": "querySelector(All) on the page",
  "handoff(sid, 'exit' | 'enter')": "the motif rect {x,y,w,h,r} the director planned at a cut, or null",
  "pop / rise / slideX / flipIn / smear (e, t, o)": "entrances; o.d duration, o.stagger, o.ease",
  "slam(e, t, { soft })": "lands oversized and blurred on t, squashes, settles",
  "lineIn(e, t)": "words rise out of a .mask line",
  "typeWords(e, t, each)": "reveal the .w word spans of a .split element one by one",
  "typeIn(e, t)": "stepped clip reveal of a text element",
  "draw(e, t, d)": "stroke-draw an SVG path with class draw and pathLength=1",
  "odo(e, t)": "roll the digit reels of <span class=odo data-value=40%>",
  "bump / press / ripple / sweep (e, t)":
    "accents: scale pulse, press, hairline ripple, light bar over a .sweep",
  "settleCam(e, t0, t1, amt) / camTo(e, t, {x,y,s}) / drift(e, t0, t1, {x,y,s})":
    "camera moves on .cam groups",
  "morphRect(e, from, to, t, d)": "tween left/top/width/height/radius between {x,y,w,h,r} rects",
  "fadeOut(e, t) / flash(t) / shake(e, t)": "exits and punctuation (flash and shake for drops only)",
  "rng(seed)": "seeded random numbers; Math.random is not allowed",
  "envKeys(e, t0, t1, step, map)": "keyframes from the voice envelope (flat when there is none)",
};

/** Section element id of a scene in the shell. */
export const sceneSectionId = (sid: string) => `sc-${sid.replace(/[^A-Za-z0-9_-]/g, "-")}`;

const BANNED_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "track",
  "image",
  "feimage",
  "foreignobject",
  "form",
  "input",
  "textarea",
  "select",
  "template",
  "slot",
  "portal",
  "html",
  "head",
  "body",
]);
/** Attributes that load or link something. `href` may only point at `#id` (SVG `use`, gradients). */
const LINK_ATTRIBUTES = new Set([
  "src",
  "srcset",
  "href",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "data",
  "background",
  "ping",
]);
const URL_SCHEME = /\b(?:https?|wss?|ftp|file|data|blob|javascript|vbscript):/i;
const PROTOCOL_RELATIVE = /(?:^|["'`(\s])\/\/[^\s/]/;
const URL_CALL = /url\(\s*(["']?)([^)"']*)\1\s*\)/gi;

/** Every `url(...)` in `value` points at a `#fragment`. */
const fragmentUrlsOnly = (value: string) =>
  [...value.matchAll(URL_CALL)].every((m) => (m[2] ?? "").trim().startsWith("#"));

function htmlProblems(html: string, problems: string[]): void {
  const doc = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true });
  const seen = new Set<string>();
  const once = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      problems.push(p);
    }
  };
  const walk = (nodes: typeof doc.children) => {
    for (const node of nodes) {
      if (node.type === "directive" || node.type === "cdata") once("html: doctype and CDATA are not allowed");
      if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
      const tag = node.name.toLowerCase();
      if (BANNED_TAGS.has(tag)) {
        once(
          `html: <${tag}> is not allowed (no scripts, styles, media, frames, forms or links in a fragment)`,
        );
        continue;
      }
      if (tag === "section") once("html: write the scene's content only; Studix adds its <section>");
      for (const [name, value] of Object.entries(node.attribs)) {
        const attr = name.toLowerCase();
        if (attr.startsWith("on")) once(`html: event handler attribute "${name}" is not allowed`);
        else if (LINK_ATTRIBUTES.has(attr) && !value.trim().startsWith("#"))
          once(`html: "${name}" may only point at #ids in the scene (no files or URLs)`);
        else if (URL_SCHEME.test(value) || PROTOCOL_RELATIVE.test(value))
          once(`html: attribute "${name}" holds a URL; fragments load nothing`);
        else if (!fragmentUrlsOnly(value)) once(`html: url(...) in "${name}" may only point at #ids`);
      }
      walk(node.children);
    }
  };
  walk(doc.children);
}

/** Properties that would run time outside the timeline or bind behaviour. */
const BANNED_PROPERTIES = /^(?:-[a-z]+-)?(?:animation|transition)(?:-|$)|^(?:behavior|-moz-binding)$/i;

/** The fragment's CSS with every selector under `#<sectionId>`; problems are appended. */
function scopedCss(css: string, sectionId: string, problems: string[]): string {
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch (err) {
    problems.push(
      `css: parse error: ${err instanceof CssSyntaxError ? `${err.reason} (line ${err.line})` : String(err)}`,
    );
    return "";
  }
  const scope = `#${sectionId}`;
  root.walkAtRules((rule) => {
    problems.push(
      `css: @${rule.name} is not allowed (no at-rules: fonts, keyframes and media come from the shell)`,
    );
  });
  root.walkDecls((decl) => {
    if (BANNED_PROPERTIES.test(decl.prop))
      problems.push(`css: ${decl.prop} is not allowed (every motion runs on the timeline)`);
    if (!fragmentUrlsOnly(decl.value) || URL_SCHEME.test(decl.value))
      problems.push(`css: the value of ${decl.prop} loads a URL; url(...) may only point at #ids`);
    if (/\b(?:expression|image-set|element)\s*\(/i.test(decl.value))
      problems.push(`css: ${decl.prop} uses expression(), image-set() or element()`);
  });
  root.walkRules((rule) => {
    if (rule.parent?.type !== "root") return;
    rule.selectors = rule.selectors.map((raw) => {
      const sel = raw.trim();
      if (/(?:^|[\s>+~,(])(?:html|body|:root)(?![\w-])/i.test(sel) || /^#root\b|^#stage\b/.test(sel)) {
        problems.push(`css: selector "${sel}" leaves the scene; style only the scene's own elements`);
        return sel;
      }
      if (sel === ":scope" || sel === scope) return scope;
      if (sel.startsWith(":scope")) return `${scope}${sel.slice(":scope".length)}`;
      if (sel.startsWith(`${scope} `) || sel.startsWith(`${scope}.`) || sel.startsWith(`${scope}:`))
        return sel;
      return `${scope} ${sel}`;
    });
  });
  return root.toString();
}

/** Globals and calls a choreography script must not touch: network, wall clock, randomness, own timelines. */
const BANNED_JS: ReadonlyArray<[RegExp, string]> = [
  [
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon|importScripts|Worker|SharedWorker)\b/,
    "network access",
  ],
  [/\bimport\s*\(|\bimport\s+[\w{*]|\brequire\s*\(/, "imports"],
  [/\b(?:eval|Function)\s*\(|\bnew\s+Function\b/, "eval and Function"],
  [/\bDate\b|\bperformance\b/, "the wall clock (Date, performance)"],
  [/\bMath\.random\b/, "Math.random (use rng(seed))"],
  [
    /\b(?:requestAnimationFrame|setTimeout|setInterval|requestIdleCallback|queueMicrotask)\b/,
    "timers (every motion is a timeline tween)",
  ],
  [
    /\bgsap\s*\.\s*(?:to|from|fromTo|timeline|delayedCall|ticker|globalTimeline|exportRoot)\b/,
    "GSAP tweens outside `tl`",
  ],
  [
    /\b(?:window|globalThis|document\.(?:write|cookie|open|location|domain)|location|localStorage|sessionStorage|indexedDB|caches|postMessage)\b/,
    "page globals",
  ],
  [
    /\.(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc)\b/,
    "HTML injection (build elements with createElement)",
  ],
  [
    /createElement(?:NS)?\s*\([^)]*["'`](?:script|style|link|img|image|iframe|video|audio|source|object|embed|foreignObject)["'`]/i,
    "elements that load files",
  ],
  [/__timelines\b/, "the timeline registry (the shell registers `tl`)"],
];

/** Words a `W(sid, "...")` or `WE(...)` call names, so each can be checked against the scene's spoken words. */
const WORD_CALL = /\bWE?\(\s*sid\s*,\s*(["'`])((?:(?!\1).)*)\1/g;

export interface SceneFragmentCheck {
  /** The scene id the fragment is written for (TIMING.scenes key). */
  sid: string;
  /** Spoken words of the scene as W() looks them up; omitted when the job has no word timings. */
  words?: readonly string[];
}

export interface CheckedSceneFragment {
  /** The fragment as the shell splices it: section markup, scoped CSS and the script body. */
  section: string;
  css: string;
  js: string;
  /** Every contract rule the fragment breaks; the fragment must not be used unless this is empty. */
  problems: string[];
}

/** Check a fragment against the contract and prepare it for the shell (section wrapper, scoped CSS). */
export function checkSceneFragment(fragment: SceneFragment, check: SceneFragmentCheck): CheckedSceneFragment {
  const problems: string[] = [];
  const parsed = SceneFragment.safeParse(fragment);
  if (!parsed.success) {
    return {
      section: "",
      css: "",
      js: "",
      problems: parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "/"}: ${i.message}`),
    };
  }
  const { html, css, js } = parsed.data;
  const sectionId = sceneSectionId(check.sid);
  htmlProblems(html, problems);
  const scoped = scopedCss(css, sectionId, problems);

  // A syntax check without running anything; comments go, so they cannot trip the token checks below.
  let code = "";
  try {
    code = transformSync(`(() => {\n${js}\n})();`, { loader: "js", format: "esm", target: "es2022" }).code;
  } catch (err) {
    const first = (err as { errors?: Array<{ text: string; location?: { line: number } | null }> })
      .errors?.[0];
    problems.push(
      `js: syntax error: ${first ? `${first.text}${first.location ? ` (line ${first.location.line - 1})` : ""}` : String(err)}`,
    );
  }
  if (code) {
    for (const [pattern, what] of BANNED_JS)
      if (pattern.test(code)) problems.push(`js: ${what} is not allowed`);
    if (URL_SCHEME.test(code) || /(["'`])\/\/[^\s/]/.test(code))
      problems.push("js: URLs are not allowed; fragments load nothing");
  }
  if (check.words && check.words.length > 0) {
    const known = new Set(check.words);
    const missing = [...new Set([...js.matchAll(WORD_CALL)].map((m) => m[2] ?? ""))].filter(
      (w) => !known.has(w),
    );
    if (missing.length > 0) {
      problems.push(
        `js: W()/WE() name words this scene does not speak: ${missing
          .slice(0, 6)
          .map((w) => `"${w}"`)
          .join(", ")}` + " (use the lower-case spoken words listed for the scene)",
      );
    }
  }
  const section = `<section id="${sectionId}" class="scene layer" data-sid="${check.sid}">\n${html}\n</section>`;
  return { section, css: scoped, js, problems };
}

/** Every rule a fragment breaks, as short agent-readable sentences; [] when it may be used. */
export function sceneFragmentProblems(fragment: SceneFragment, check: SceneFragmentCheck): string[] {
  return checkSceneFragment(fragment, check).problems;
}

const FILE_PARTS =
  /^<!--studix-scene-fragment v1 (\S+)-->\n<template data-part="html">\n([\s\S]*)\n<\/template>\n<style>\n([\s\S]*)\n<\/style>\n<script>\n([\s\S]*)\n<\/script>\n$/;

/**
 * The fragment as stored in the composition tree, `scenes/<sid>.scene.html`: the three parts the agent wrote,
 * unchanged, so one scene can be read and rewritten later on its own.
 */
export function sceneFragmentFile(sid: string, fragment: SceneFragment): string {
  return [
    `<!--studix-scene-fragment v1 ${sid}-->`,
    '<template data-part="html">',
    fragment.html,
    "</template>",
    "<style>",
    fragment.css,
    "</style>",
    "<script>",
    fragment.js,
    "</script>",
    "",
  ].join("\n");
}

/** Reads a stored fragment file back; undefined when the file is not one `sceneFragmentFile` wrote. */
export function parseSceneFragmentFile(text: string): { sid: string; fragment: SceneFragment } | undefined {
  const m = FILE_PARTS.exec(text);
  if (!m) return undefined;
  const parsed = SceneFragment.safeParse({ html: m[2], css: m[3], js: m[4] });
  return parsed.success ? { sid: m[1] as string, fragment: parsed.data } : undefined;
}
