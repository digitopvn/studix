import { lintHyperframeHtml } from "@hyperframes/lint";

/**
 * Static HyperFrames lint of one assembled director page, in the worker (no sandbox, no browser): the error
 * findings as short lines. The film check uses it on single-scene pages to place a lint error the film's report
 * could not attribute, so one scene's lint error never costs the whole film.
 */
export async function lintDirectorPage(html: string): Promise<string[]> {
  const result = await lintHyperframeHtml(html, { filePath: "index.html" });
  return result.findings
    .filter((f) => f.severity === "error")
    .map((f) => [f.code, f.selector, f.message].filter(Boolean).join(" ").slice(0, 300));
}
