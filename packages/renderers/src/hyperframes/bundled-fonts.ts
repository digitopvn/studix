// Adapted from motion-mcp packages/hyperframes-adapter/src/fonts.ts @ 408ceccd (MIT, Copyright (c) 2026 Digitop).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DEFAULT_FONT_FAMILY } from "./brand-tokens.ts";
import { cmp } from "./html-utils.ts";

/**
 * Font strategy: deterministic and offline.
 *
 * The HyperFrames producer injects @font-face rules at render time for families without one, which can
 * mean a Google Fonts download or a capture of a machine-local font: output then differs per machine and
 * fails offline. The compiler therefore ships fonts inside the project: each family resolves to an
 * `@fontsource/<slug>` package pinned in this package, its latin, latin-ext and vietnamese woff2 subsets
 * are copied into `assets/fonts/`, and every composition declares matching @font-face rules with
 * `font-display: block`. A family qualifies only if it has a vietnamese subset, so Vietnamese text never
 * falls back to a system font; anything else is substituted with Be Vietnam Pro and reported.
 */

const require = createRequire(import.meta.url);
const SUBSETS = ["latin", "latin-ext", "vietnamese"] as const;

interface FontsourceMetadata {
  id: string;
  family: string;
  subsets: string[];
  weights: number[];
  category?: string;
}

interface FontPackage {
  dir: string;
  meta: FontsourceMetadata;
  unicode: Record<string, string>;
}

export interface FontRequest {
  /** Family named by the brand kit (e.g. "Be Vietnam Pro"). */
  family: string;
  weights: ReadonlySet<number>;
}

export interface FontPlan {
  /** Requested family -> CSS font-family stack actually used. */
  stacks: Map<string, string>;
  /** `{dest, source}` copies (dest under assets/fonts/), sorted by dest. */
  files: { dest: string; source: string }[];
  css: string;
  warnings: string[];
}

export const fontSlug = (family: string): string =>
  family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const packageCache = new Map<string, FontPackage | null>();

function loadFontPackage(family: string): FontPackage | null {
  const slug = fontSlug(family);
  if (!slug) return null;
  const cached = packageCache.get(slug);
  if (cached !== undefined) return cached;
  let pkg: FontPackage | null = null;
  try {
    const metaPath = require.resolve(`@fontsource/${slug}/metadata.json`);
    const dir = dirname(metaPath);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as FontsourceMetadata;
    const unicode = JSON.parse(readFileSync(join(dir, "unicode.json"), "utf8")) as Record<string, string>;
    pkg = meta.subsets.includes("vietnamese") ? { dir, meta, unicode } : null;
  } catch {
    pkg = null;
  }
  packageCache.set(slug, pkg);
  return pkg;
}

/** Nearest available weight; ties resolve to the heavier face so text never looks lighter than asked. */
export function nearestWeight(available: readonly number[], wanted: number): number {
  let best = available[0] ?? 400;
  for (const w of available) {
    const d = Math.abs(w - wanted);
    const bd = Math.abs(best - wanted);
    if (d < bd || (d === bd && w > best)) best = w;
  }
  return best;
}

/** Resolve requested families to bundled files for exactly the weights the composition uses. */
export function planFonts(requests: readonly FontRequest[]): FontPlan {
  const warnings: string[] = [];
  const stacks = new Map<string, string>();
  // family -> weight -> faces; Map keeps merges of roles sharing one family simple.
  const faces = new Map<string, { pkg: FontPackage; weights: Set<number> }>();

  for (const request of requests) {
    let pkg = loadFontPackage(request.family);
    if (!pkg) {
      pkg = loadFontPackage(DEFAULT_FONT_FAMILY);
      if (!pkg) throw new Error(`bundled font @fontsource/${fontSlug(DEFAULT_FONT_FAMILY)} is not installed`);
      warnings.push(
        `font "${request.family}" has no bundled Vietnamese-capable files; substituted "${pkg.meta.family}"`,
      );
    }
    const family = pkg.meta.family;
    const generic =
      pkg.meta.category === "serif"
        ? "serif"
        : pkg.meta.category === "monospace"
          ? "monospace"
          : "sans-serif";
    stacks.set(request.family, `"${family}", ${generic}`);
    const entry = faces.get(family) ?? { pkg, weights: new Set<number>() };
    for (const w of request.weights) entry.weights.add(w);
    faces.set(family, entry);
  }

  const files = new Map<string, string>();
  const css: string[] = [];
  for (const family of [...faces.keys()].sort(cmp)) {
    const { pkg, weights } = faces.get(family)!;
    for (const weight of [...weights].sort((a, b) => a - b)) {
      // Declare the requested weight but point at the nearest real file, so the browser never fakes bold.
      const fileWeight = nearestWeight(pkg.meta.weights, weight);
      for (const subset of SUBSETS.filter((s) => pkg.meta.subsets.includes(s))) {
        const file = `${pkg.meta.id}-${subset}-${fileWeight}-normal.woff2`;
        const dest = `assets/fonts/${file}`;
        files.set(dest, join(pkg.dir, "files", file));
        css.push(
          [
            "@font-face {",
            `  font-family: "${family}";`,
            // Relative to the project root: composition templates are mounted into index.html.
            `  src: url("${dest}") format("woff2");`,
            `  font-weight: ${weight};`,
            "  font-style: normal;",
            "  font-display: block;",
            `  unicode-range: ${pkg.unicode[subset] ?? "U+0000-FFFF"};`,
            "}",
          ].join("\n"),
        );
      }
    }
  }

  return {
    stacks,
    files: [...files.entries()].sort(([a], [b]) => cmp(a, b)).map(([dest, source]) => ({ dest, source })),
    css: css.join("\n"),
    warnings,
  };
}
