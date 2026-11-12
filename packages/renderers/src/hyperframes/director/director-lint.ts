import { lintHyperframeHtml } from "@hyperframes/lint";

/**
 * Static HyperFrames lint of one assembled director page, in the worker (no sandbox, no browser): the error
 * findings as short lines. The film check uses it on single-scene pages to place a lint error the film's report
 * could not attribute, so one scene's lint error never costs the whole film.
 */
/**
 * Lint codes the check rates `error` that only warn of a quality risk (motion that may stutter), never a broken
 * scene: they do not cost a scene its authored clip.
 */
export const ADVISORY_LINT_CODES: ReadonlySet<string> = new Set(["gsap_non_transform_motion"]);

/** A check finding that blocks: rated `error` and not advisory. */
export const isBlockingFinding = (f: { severity?: string; code?: string }) =>
  f.severity === "error" && !(f.code !== undefined && ADVISORY_LINT_CODES.has(f.code));

export async function lintDirectorPage(html: string): Promise<string[]> {
  const result = await lintHyperframeHtml(html, { filePath: "index.html" });
  return result.findings
    .filter(isBlockingFinding)
    .map((f) => [f.code, f.selector, f.message].filter(Boolean).join(" ").slice(0, 300));
}
