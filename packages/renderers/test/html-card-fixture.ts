import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSequentialTimeline, type VideoIR } from "@studix/video-ir";
import { HTML_CARD_FORMAT, HTML_CARD_MIME, type HtmlCardPackage } from "../src/index.ts";

/** A hero card shaped like what a director agent writes: inline SVG, nested CSS, a GSAP script. */
export const CLEAN_CARD: HtmlCardPackage = {
  format: HTML_CARD_FORMAT,
  version: 1,
  html: [
    '<div class="wrap">',
    '  <svg class="ring" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    '    <defs><linearGradient id="g"><stop offset="0" stop-color="#f59e0b" /><stop offset="1" stop-color="#ef4444" /></linearGradient></defs>',
    '    <circle cx="50" cy="50" r="40" fill="none" stroke="url(#g)" stroke-width="8" />',
    "  </svg>",
    '  <h1 class="title">Ra mắt Studix 2.0</h1>',
    '  <p class="sub">Video AI, nhanh gấp đôi</p>',
    "</div>",
  ].join("\n"),
  css: [
    "background: radial-gradient(circle at 30% 20%, var(--c-primary), var(--c-background));",
    ".wrap { position: absolute; inset: 8%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4%; }",
    ".ring { width: 30%; }",
    ".title { font-family: var(--font-heading); font-weight: 800; font-size: 11vmin; color: var(--c-foreground); margin: 0; }",
    ".sub { font-family: var(--font-body); font-weight: 600; font-size: 6vmin; color: var(--c-accent); margin: 0; }",
  ].join("\n"),
  script: [
    'var title = root.querySelector(".title");',
    'var sub = root.querySelector(".sub");',
    'tl.fromTo(root.querySelector(".ring"), { rotation: -90, scale: 0.6 }, { rotation: 0, scale: 1, duration: 0.8, ease: "power3.out" }, 0);',
    'tl.fromTo(title, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out" }, 0.2);',
    'tl.fromTo(sub, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" }, frame.duration * 0.25);',
  ].join("\n"),
};

/** Write `card` as a code asset file in `dir`; returns its path. */
export async function writeCard(dir: string, card: HtmlCardPackage = CLEAN_CARD): Promise<string> {
  const path = join(dir, "card.json");
  await writeFile(path, JSON.stringify(card), "utf8");
  return path;
}

/** Text scene, then an HTML card scene starting 200 ms in, with burned captions over both. */
export function cardIr(cardFile: string, size = { width: 540, height: 960 }): VideoIR {
  const scenes: VideoIR["scenes"] = [
    {
      id: "intro",
      role: "intro",
      durationMs: 1500,
      background: { color: "background" },
      shots: [{ id: "hello", type: "text", text: "Xin chào", startMs: 0, durationMs: 1500 }],
      transitionOut: { kind: "fade", durationMs: 300 },
    },
    {
      id: "hero",
      role: "feature",
      durationMs: 2500,
      background: { color: "background" },
      shots: [{ id: "card", type: "composition", assetId: "hero-card", startMs: 200, durationMs: 2300 }],
    },
  ];
  return {
    schemaVersion: 1,
    title: "HTML card",
    language: "vi",
    format: { aspectRatio: "9:16", width: size.width, height: size.height, fps: 30, durationMs: 4000 },
    assets: [
      {
        id: "hero-card",
        kind: "code",
        uri: pathToFileURL(cardFile).href,
        sha256: createHash("sha256").update(cardFile).digest("hex"),
        mime: HTML_CARD_MIME,
        assetVersionId: "v1",
        provenance: { source: "generated" },
      },
    ],
    scenes,
    timeline: buildSequentialTimeline(scenes),
    captions: {
      language: "vi",
      mode: "burned",
      cues: [
        { startMs: 0, endMs: 1500, text: "Xin chào" },
        { startMs: 1500, endMs: 4000, text: "Studix 2.0" },
      ],
    },
  };
}
