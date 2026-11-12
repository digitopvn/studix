import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { StudixError } from "@studix/shared";
import type { ColorRole } from "@studix/video-ir";
import {
  BURNED_CAPTION,
  burnedCaptionEdge,
  DEFAULT_FONT_FAMILY,
  DEFAULT_PALETTE,
  frameScale,
  MONO_FONT_FAMILY,
} from "../brand-tokens.ts";
import { planFonts } from "../bundled-fonts.ts";
import { GSAP_ASSET } from "../compile-composition.ts";
import { scriptJson } from "../html-utils.ts";
import { type CheckedSceneFragment, sceneSectionId } from "./scene-fragment.ts";

/**
 * The director shell: a versioned HTML/GSAP page Studix owns (`director-shell.v<N>.html`), extracted from the
 * ak-motion-video skeleton and its film helpers. It holds the timing lookups (W, WE, B), the animation
 * vocabulary (pop, slam, settleCam, flash, ...), the caption system, the handoff map and the theme tokens;
 * agent-authored scene fragments only fill its scene markers. A new shell version is a new file, so stored
 * compositions keep rendering with the shell they were assembled with.
 */
export const DIRECTOR_SHELL_VERSION = 1;

const require = createRequire(import.meta.url);
let shellText: string | undefined;
const shell = () => {
  shellText ??= readFileSync(
    new URL(`./director-shell.v${DIRECTOR_SHELL_VERSION}.html`, import.meta.url),
    "utf8",
  );
  return shellText;
};

/** A rect in frame pixels: top-left `x`/`y`, or its centre `cx`/`cy`; `r` is the corner radius. */
export interface HandoffRect {
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  w: number;
  h: number;
  r?: number;
}

/** `window.TIMING`: every time the shell and the fragments use, in seconds on the composition timeline. */
export interface DirectorTiming {
  duration: number;
  fps: number;
  /** Beat grid: quarter note n is at `beat0 + beatLen * n`. */
  beat0: number;
  beatLen: number;
  /** Beat ranges [from, to) of loud sections, where beat reactions fire. */
  kick: Array<[number, number]>;
  /** Beats where the music drops (a flash lands on each). */
  drops: number[];
  /** Beat reactions stop at this beat. */
  outroBeat: number;
  /** Scenes by id; `words` are [word, start, end] with words lower-cased and stripped (`timingWord`). */
  scenes: Record<
    string,
    {
      start: number;
      end: number;
      lines: Array<{ on: number; off: number; words: Array<[string, number, number]> }>;
    }
  >;
  /** Karaoke caption chunks; empty when the captions are burned elsewhere. */
  captions: Array<{ start: number; end: number; words: Array<[string, number]> }>;
  /** Voice envelope, one 0..1 value per frame; empty without one. */
  env: number[];
  /** The carried motif's rect where it leaves (`exit`) or enters (`enter`) each scene. */
  handoff: Record<string, { exit?: HandoffRect; enter?: HandoffRect }>;
  /** A whole film fades in from and out to black; a scene clip cut into a film does not. */
  options: { fadeIn: boolean; fadeOut: boolean };
}

/** Brand kit and style colours and fonts the shell exposes as CSS tokens. */
export interface DirectorTheme {
  palette: Partial<Record<ColorRole, string>>;
  fonts?: { heading: string; body: string };
}

export interface DirectorProjectInput {
  width: number;
  height: number;
  timing: DirectorTiming;
  theme: DirectorTheme;
  /** Checked fragments in timeline order (`checkSceneFragment`); none with problems. */
  scenes: ReadonlyArray<{ sid: string; fragment: CheckedSceneFragment }>;
}

export interface DirectorProject {
  /** Project-relative path -> text (index.html). */
  files: Map<string, string>;
  /** Project-relative destination -> absolute source file (fonts, GSAP). */
  copies: Map<string, string>;
  warnings: string[];
}

/**
 * How W() looks a word up: lower-case, letters and digits kept (Vietnamese diacritics too), inner apostrophes
 * and hyphens kept, everything else dropped ("Studix," -> "studix", "let's" -> "let's").
 */
export function timingWord(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]+/gu, "")
    .replace(/^['-]+|['-]+$/g, "");
}

const RATIO = (w: number, h: number) =>
  Math.abs(w / h - 9 / 16) < 0.01 ? "9x16" : Math.abs(w - h) < 2 ? "1x1" : "16x9";
const HEX = /^#[0-9a-f]{3,8}$/i;
const FAMILY = /^[\w ,.'"-]{1,80}$/;

/** `--token: value` lines of the theme; colours must be hex and families plain names, since they land in CSS. */
function themeCss(
  theme: DirectorTheme,
  stacks: Record<"heading" | "body" | "mono", string>,
  w: number,
  h: number,
) {
  const p = { ...DEFAULT_PALETTE, ...theme.palette };
  for (const [role, value] of Object.entries(p)) {
    if (!HEX.test(value)) {
      throw new StudixError("VALIDATION", `Theme colour ${role} must be a hex colour`, {
        retryable: false,
        details: { role, value },
      });
    }
  }
  const mix = (pct: number) => `color-mix(in srgb, ${p.foreground} ${pct}%, transparent)`;
  const scale = frameScale({ width: w, height: h });
  return [
    ":root {",
    `  --W: ${w}px; --H: ${h}px;`,
    `  --bg: ${p.background}; --ink: ${p.foreground}; --primary: ${p.primary}; --secondary: ${p.secondary};`,
    `  --accent: ${p.accent}; --muted: ${p.muted};`,
    `  --mute: ${mix(56)}; --faint: ${mix(32)}; --hair: ${mix(12)}; --surface: ${mix(5)};`,
    `  --font-heading: ${stacks.heading}; --font-body: ${stacks.body}; --font-mono: ${stacks.mono};`,
    `  --cap-size: ${Math.round(BURNED_CAPTION.sizeAt1080 * scale)}px; --cap-bottom: ${burnedCaptionEdge({ width: w, height: h })}px;`,
    "}",
  ].join("\n");
}

/** One guarded block per fragment: only runs when its scene is in TIMING, with the scene's names in scope. */
function sceneBlock(sid: string, sectionId: string, js: string): string {
  const id = JSON.stringify(sid);
  return [
    `/* scene ${sid.replace(/\*\//g, "")} */ { const sid = ${id}; const S = ${JSON.stringify(`#${sectionId}`)}; if (SC[sid]) {`,
    "const t0 = SC[sid].start, t1 = SC[sid].end;",
    'const $s = (q) => $(S + " " + q), $$s = (q) => $$(S + " " + q);',
    js,
    "} }",
  ].join("\n");
}

/**
 * Fill every marker pair of the pristine shell in one pass: each pair is located in the shell before any content
 * is inserted, so text inside a fragment can never be taken for a marker.
 */
function fillAll(
  shellPage: string,
  fills: ReadonlyArray<[begin: string, end: string, content: string]>,
): string {
  const spans = fills
    .map(([begin, end, content]) => {
      const a = shellPage.indexOf(begin);
      const b = a < 0 ? -1 : shellPage.indexOf(end, a + begin.length);
      if (a < 0 || b < 0) throw new StudixError("INTERNAL", `Director shell lacks the ${begin} marker`);
      return { from: a + begin.length, to: b, content };
    })
    .sort((x, y) => x.from - y.from);
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += `${shellPage.slice(at, span.from)}\n${span.content}\n`;
    at = span.to;
  }
  return out + shellPage.slice(at);
}

/**
 * The shell with the theme, fonts, TIMING and the fragments spliced in, plus the files it needs (bundled
 * fonts with Vietnamese coverage, GSAP): an offline, deterministic HyperFrames project.
 */
export function buildDirectorProject(input: DirectorProjectInput): DirectorProject {
  const { width, height, timing, theme } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16) {
    throw new StudixError("VALIDATION", "The director shell needs a whole-pixel frame size", {
      retryable: false,
      details: { width, height },
    });
  }
  const families = {
    heading: theme.fonts?.heading ?? DEFAULT_FONT_FAMILY,
    body: theme.fonts?.body ?? DEFAULT_FONT_FAMILY,
  };
  for (const f of Object.values(families)) {
    if (!FAMILY.test(f))
      throw new StudixError("VALIDATION", "Theme font families must be plain names", { retryable: false });
  }
  // Fragments may set any weight; these cover what the helpers and the style tokens use.
  const fonts = planFonts([
    { family: families.heading, weights: new Set([600, 700, 800]) },
    { family: families.body, weights: new Set([400, 500, 600, 700]) },
    { family: MONO_FONT_FAMILY, weights: new Set([400, 600]) },
  ]);
  const stack = (family: string) => fonts.stacks.get(family) ?? `"${DEFAULT_FONT_FAMILY}", sans-serif`;
  const stacks = {
    heading: stack(families.heading),
    body: stack(families.body),
    mono: stack(MONO_FONT_FAMILY),
  };

  const missing = input.scenes.filter((s) => !timing.scenes[s.sid]).map((s) => s.sid);
  const broken = input.scenes.filter((s) => s.fragment.problems.length > 0).map((s) => s.sid);
  if (missing.length > 0 || broken.length > 0) {
    throw new StudixError("VALIDATION", "Only checked fragments of scenes in TIMING can be assembled", {
      retryable: false,
      details: { missing, broken },
    });
  }
  const sections = input.scenes.map((s) => s.fragment.section).join("\n");
  const css = input.scenes.map((s) => `/* ${s.sid} */\n${s.fragment.css}`).join("\n");
  const js = input.scenes.map((s) => sceneBlock(s.sid, sceneSectionId(s.sid), s.fragment.js)).join("\n");

  const pristine = shell()
    .replaceAll("__STUDIX_W__", String(width))
    .replaceAll("__STUDIX_H__", String(height))
    .replaceAll("__STUDIX_RATIO__", RATIO(width, height))
    .replaceAll("__STUDIX_FPS__", String(timing.fps))
    .replaceAll("__STUDIX_DURATION__", String(timing.duration));
  const page = fillAll(pristine, [
    ["/*FONTS:BEGIN*/", "/*FONTS:END*/", fonts.css],
    ["/*THEME:BEGIN*/", "/*THEME:END*/", themeCss(theme, stacks, width, height)],
    // The CSS sits inside <style>: a `</style` in a value would end it early.
    ["/*SCENE-CSS:BEGIN*/", "/*SCENE-CSS:END*/", css.replace(/<\/style/gi, "<\\/style")],
    ["<!--SCENES:BEGIN-->", "<!--SCENES:END-->", sections],
    ["/*TIMING:BEGIN*/", "/*TIMING:END*/", `window.TIMING=${scriptJson(timing)};`],
    ["/*SCENE-JS:BEGIN*/", "/*SCENE-JS:END*/", js.replace(/<\/script/gi, "<\\/script")],
  ]);

  const copies = new Map<string, string>(fonts.files.map((f) => [f.dest, f.source]));
  copies.set(GSAP_ASSET, require.resolve("gsap/dist/gsap.min.js"));
  return { files: new Map([["index.html", page]]), copies, warnings: fonts.warnings };
}
