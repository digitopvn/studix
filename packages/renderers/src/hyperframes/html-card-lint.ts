import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type HyperframeLintFinding, lintProject } from "@hyperframes/lint";
import { StudixError } from "@studix/shared";
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type BrandPalette,
  unwrapValidation,
  type VideoIR,
  validateVideoIR,
} from "@studix/video-ir";
import { DEFAULT_FONT_FAMILY, DEFAULT_PALETTE } from "./brand-tokens.ts";
import { buildComposition, writeComposition } from "./compile-composition.ts";
import { HTML_CARD_MIME, HtmlCardPackage, htmlCardProblems } from "./html-card.ts";

export interface LintHtmlCardOptions {
  /** Render frame size the card is checked at. */
  width: number;
  height: number;
  /** Card length (the composition shot duration). */
  durationMs: number;
  /** Brand palette roles exposed as `--c-<role>`; missing roles use the neutral defaults. */
  palette?: Partial<BrandPalette>;
  /** Families behind `--font-heading` / `--font-body`. */
  fonts?: { heading: string; body: string };
  /** Scratch directory; a temporary project is created under it and removed afterwards. */
  workDir: string;
}

export interface HtmlCardLintResult {
  errors: string[];
  warnings: string[];
}

const RATIO_VALUE: Record<AspectRatio, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };

function aspectRatioOf(width: number, height: number): AspectRatio {
  const ratio = ASPECT_RATIOS.find((r) => Math.abs(width / height - RATIO_VALUE[r]) / RATIO_VALUE[r] <= 0.01);
  if (!ratio) {
    throw new StudixError("VALIDATION", `Frame ${width}x${height} matches no supported aspect ratio`, {
      details: { width, height, supported: ASPECT_RATIOS },
    });
  }
  return ratio;
}

/** A one-scene IR whose only shot is the card, so the linter sees it exactly as a render would. */
function cardIr(pkgJson: string, file: string, opts: LintHtmlCardOptions): VideoIR {
  const p = opts.palette ?? {};
  return unwrapValidation(
    validateVideoIR({
      schemaVersion: 1,
      title: "HTML card lint",
      language: "en",
      format: {
        aspectRatio: aspectRatioOf(opts.width, opts.height),
        width: opts.width,
        height: opts.height,
        fps: 30,
        durationMs: opts.durationMs,
      },
      brand: {
        name: "HTML card",
        palette: {
          primary: p.primary ?? DEFAULT_PALETTE.primary,
          secondary: p.secondary ?? DEFAULT_PALETTE.secondary,
          accent: p.accent ?? DEFAULT_PALETTE.accent,
          background: p.background ?? DEFAULT_PALETTE.background,
          foreground: p.foreground ?? DEFAULT_PALETTE.foreground,
          muted: p.muted ?? DEFAULT_PALETTE.muted,
        },
        fonts: opts.fonts ?? { heading: DEFAULT_FONT_FAMILY, body: DEFAULT_FONT_FAMILY },
      },
      assets: [
        {
          id: "card",
          kind: "code",
          uri: pathToFileURL(file).href,
          sha256: createHash("sha256").update(pkgJson).digest("hex"),
          mime: HTML_CARD_MIME,
          bytes: Buffer.byteLength(pkgJson),
          assetVersionId: "html-card-lint",
          provenance: { source: "generated" },
        },
      ],
      scenes: [
        {
          id: "card",
          role: "feature",
          durationMs: opts.durationMs,
          background: { color: "background" },
          shots: [
            {
              id: "card",
              type: "composition",
              assetId: "card",
              startMs: 0,
              durationMs: opts.durationMs,
              animation: { enter: "none" },
            },
          ],
        },
      ],
      timeline: { entries: [{ sceneId: "card", startMs: 0 }] },
    }),
    "HTML card lint IR",
  );
}

/** Hints that fit a card better than the generic linter advice (cards cannot declare @font-face). */
const CARD_HINTS: Readonly<Record<string, string>> = {
  font_family_without_font_face:
    "use font-family: var(--font-heading) or var(--font-body); fonts are bundled.",
};

/** One finding as an agent-readable line; locations point into a temporary project, so they are left out. */
function findingText(f: HyperframeLintFinding): string {
  const hint = CARD_HINTS[f.code] ?? f.fixHint;
  return `${f.code}: ${f.message}${hint ? ` Fix: ${hint}` : ""}`;
}

/**
 * Check an HTML card before it is stored: the schema and allowlists first, then the HyperFrames linter on a
 * one-scene project built from the card exactly as a render would compile it. Never throws: findings and
 * internal failures (bad options, an unwritable work directory) both come back as `errors`, so the caller
 * can keep its built-in card.
 */
export async function lintHtmlCard(
  pkg: HtmlCardPackage,
  opts: LintHtmlCardOptions,
): Promise<HtmlCardLintResult> {
  const parsed = HtmlCardPackage.safeParse(pkg);
  if (!parsed.success)
    return {
      errors: parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "/"}: ${i.message}`),
      warnings: [],
    };
  const problems = htmlCardProblems(parsed.data);
  if (problems.length > 0) return { errors: problems, warnings: [] };
  const late = parsed.data.tweens
    .filter((t) => (t.at + t.duration) * 1000 > opts.durationMs)
    .map(
      (t) =>
        `tween on "${t.target}" ends at ${t.at + t.duration} s, after the card ends at ${opts.durationMs / 1000} s`,
    );

  let dir: string | undefined;
  try {
    await mkdir(opts.workDir, { recursive: true });
    dir = await mkdtemp(join(opts.workDir, "html-card-lint-"));
    const pkgJson = JSON.stringify(parsed.data);
    const file = join(dir, "card.json");
    await writeFile(file, pkgJson, "utf8");
    const ir = cardIr(pkgJson, file, opts);
    const build = buildComposition(ir, {
      width: opts.width,
      height: opts.height,
      assetFiles: { card: file },
    });
    const projectDir = join(dir, "project");
    await writeComposition(build, projectDir);
    const lint = await lintProject(projectDir);
    const findings = lint.results.flatMap((r) => r.result.findings);
    return {
      errors: findings.filter((f) => f.severity === "error").map(findingText),
      warnings: [
        ...late,
        ...build.warnings,
        ...findings.filter((f) => f.severity === "warning").map(findingText),
      ],
    };
  } catch (err) {
    return {
      errors: [`internal: the card could not be linted: ${err instanceof Error ? err.message : String(err)}`],
      warnings: late,
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
