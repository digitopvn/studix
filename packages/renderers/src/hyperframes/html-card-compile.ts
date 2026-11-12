import { readFileSync } from "node:fs";
import { StudixError } from "@studix/shared";
import type { Shot, VideoIR } from "@studix/video-ir";
import { HTML_CARD_MIME, HtmlCardPackage, htmlCardProblems } from "./html-card.ts";
import { cssRule, num, scriptJson, seconds } from "./html-utils.ts";

type CompositionShot = Extract<Shot, { type: "composition" }>;

/** Composition shots whose code asset is an HTML card, keyed by asset id. */
export function htmlCardAssetIds(ir: VideoIR): Set<string> {
  const cards = new Set(ir.assets.filter((a) => a.mime === HTML_CARD_MIME).map((a) => a.id));
  const used = new Set<string>();
  for (const scene of ir.scenes)
    for (const shot of scene.shots)
      if (shot.type === "composition" && cards.has(shot.assetId)) used.add(shot.assetId);
  return used;
}

/** Whether `shot` is a composition shot that names an HTML card asset of `ir`. */
export function isHtmlCardShot(ir: VideoIR, shot: Shot): boolean {
  if (shot.type !== "composition") return false;
  return ir.assets.some((a) => a.id === shot.assetId && a.mime === HTML_CARD_MIME);
}

/**
 * Read, parse and safety-check every HTML card the IR uses. Anything wrong is a VALIDATION error that lists
 * the problems, so a broken card never reaches the browser.
 */
export function loadHtmlCards(
  ir: VideoIR,
  assetFiles: Readonly<Record<string, string>> | undefined,
): Map<string, HtmlCardPackage> {
  const cards = new Map<string, HtmlCardPackage>();
  for (const assetId of [...htmlCardAssetIds(ir)].sort()) {
    const file = assetFiles?.[assetId];
    if (!file) throw cardError(assetId, "no local file for the code asset", ["missing code asset file"]);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw cardError(assetId, "the code asset is not readable JSON", [reason], err);
    }
    const parsed = HtmlCardPackage.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`);
      throw cardError(assetId, "the code asset is not a valid HTML card package", issues);
    }
    const problems = htmlCardProblems(parsed.data);
    if (problems.length > 0) throw cardError(assetId, "the card breaks the safety rules", problems);
    cards.set(assetId, parsed.data);
  }
  return cards;
}

function cardError(assetId: string, message: string, problems: string[], cause?: unknown): StudixError {
  return new StudixError("VALIDATION", `HTML card "${assetId}": ${message}`, {
    retryable: false,
    cause,
    details: { assetId, problems },
    suggestedAction:
      "Fix the card so htmlCardProblems() and lintHtmlCard() report nothing, then store it again.",
  });
}

/** Card layer markup and CSS: full frame, hidden until its shot window, agent CSS nested under the card id. */
export function htmlCardMarkup(
  id: string,
  pkg: HtmlCardPackage,
  fontStacks: { heading: string; body: string },
): { html: string; css: string[] } {
  return {
    html: `<div id="${id}" class="html-card">${pkg.html}</div>`,
    css: [
      cssRule(`#${id}`, [
        "position: absolute;",
        "inset: 0;",
        "overflow: hidden;",
        "box-sizing: border-box;",
        "opacity: 0;",
        `--font-heading: ${fontStacks.heading};`,
        `--font-body: ${fontStacks.body};`,
        "font-family: var(--font-body);",
      ]),
      ...(pkg.css.trim() ? [`#${id} {\n${pkg.css}\n}`] : []),
    ],
  };
}

/**
 * The card script as scene timeline statements: the agent's function fills its own GSAP sub-timeline (times
 * in seconds from the card start), which is placed on the scene timeline at the shot start.
 */
export function htmlCardScript(
  id: string,
  shot: CompositionShot,
  pkg: HtmlCardPackage,
  frame: { width: number; height: number },
): string[] {
  const info = { width: frame.width, height: frame.height, duration: seconds(shot.durationMs) };
  return [
    "(function () {",
    "  var sub = gsap.timeline();",
    "  (function (tl, root, frame) {",
    '    "use strict";',
    pkg.script,
    `  })(sub, document.getElementById(${scriptJson(id)}), ${scriptJson(info)});`,
    `  tl.add(sub, ${num(seconds(shot.startMs))});`,
    "})();",
  ];
}
