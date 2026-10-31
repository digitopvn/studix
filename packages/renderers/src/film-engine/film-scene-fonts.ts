import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The faces the film engine's page and cards name, mapped to fonts pinned in this package. Each face is
 * declared per subset with its unicode-range, so Vietnamese text never falls back to a machine font and a
 * render reads no font from the host or the network.
 */
interface FaceSpec {
  family: string;
  pkg: string;
  /** File stem inside the package's files/ directory, before `-<subset>-`. */
  stem: string;
  /** File suffix after the subset (weight or axis) and the CSS weight it declares. */
  file: string;
  weight: string;
  subsets: readonly string[];
}

const FACES: readonly FaceSpec[] = [
  {
    family: "Card Serif",
    pkg: "@fontsource-variable/source-serif-4",
    stem: "source-serif-4",
    file: "wght-normal",
    weight: "200 900",
    subsets: ["latin", "latin-ext", "vietnamese"],
  },
  {
    family: "Card Mono",
    pkg: "@fontsource/share-tech-mono",
    stem: "share-tech-mono",
    file: "400-normal",
    weight: "400",
    subsets: ["latin"],
  },
  ...["Card Sans", "Caption Sans"].map((family) => ({
    family,
    pkg: "@fontsource/be-vietnam-pro",
    stem: "be-vietnam-pro",
    file: "600-normal",
    weight: "600",
    subsets: ["latin", "latin-ext", "vietnamese"],
  })),
];

export interface FilmSceneFonts {
  css: string;
  /** Project-relative destination -> absolute source file. */
  files: Map<string, string>;
}

let cached: FilmSceneFonts | undefined;

export function filmSceneFonts(): FilmSceneFonts {
  if (cached) return cached;
  const files = new Map<string, string>();
  const css: string[] = [];
  for (const face of FACES) {
    // Fontsource packages export only their files/ and CSS, so the package root is found through a font file.
    const dir = dirname(dirname(require.resolve(`${face.pkg}/files/${face.stem}-latin-${face.file}.woff2`)));
    const unicode = JSON.parse(readFileSync(join(dir, "unicode.json"), "utf8")) as Record<string, string>;
    for (const subset of face.subsets) {
      const name = `${face.stem}-${subset}-${face.file}.woff2`;
      const dest = `assets/fonts/${name}`;
      files.set(dest, join(dir, "files", name));
      css.push(
        `      @font-face { font-family: "${face.family}"; src: url("${dest}") format("woff2"); font-weight: ${face.weight}; font-style: normal; font-display: block; unicode-range: ${unicode[subset] ?? "U+0000-FFFF"}; }`,
      );
    }
  }
  cached = { css: css.join("\n"), files };
  return cached;
}
