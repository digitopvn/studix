import type { CreativeBrief } from "./creative-brief.ts";
import type { AspectRatio } from "./primitives.ts";

/**
 * The length and frame shape a free-form prompt states, e.g. "a 60-second 16:9 (1920x1080) video" or
 * "video dọc dài 1 phút". Deterministic and offline. A length outside what a brief accepts (1 s to 10 min)
 * is ignored, so packs still clamp to their own range.
 */
export interface PromptFormat {
  aspectRatio?: AspectRatio;
  durationMs?: number;
}

const BRIEF_MIN_MS = 1000;
const BRIEF_MAX_MS = 600_000;

const NUM = String.raw`(?<![\d.,])(\d{1,3}(?:[.,]\d{1,2})?)`;
const GAP = String.raw`\s*-?\s*`;
const SECOND = String.raw`(?:giây|seconds?|secs?|s)`;
const MINUTE = String.raw`(?:phút|minutes?|mins?)`;
const END = String.raw`(?![\p{L}])`;
/** Not a decade such as "the 80s", "'90s" or "an 80s retro look". */
const NOT_DECADE = String.raw`(?<!(?:the|those)\s+|['’])`;
const DECADE_STYLE = String.raw`(?!\s+(?:retro|style|vibes?|look|aesthetics?|music|era|nostalgia|fashion|disco|synth))`;
const MINUTES_AND_SECONDS = new RegExp(
  `${NUM}${GAP}${MINUTE}\\s*(?:and\\s+|và\\s+)?${NUM}${GAP}${SECOND}${END}`,
  "iu",
);
const MINUTES = new RegExp(`${NUM}${GAP}${MINUTE}${END}`, "iu");
const SECONDS = new RegExp(`${NOT_DECADE}${NUM}${GAP}${SECOND}${END}${DECADE_STYLE}`, "iu");

const RATIO_VALUE: Record<AspectRatio, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };

const num = (s: string | undefined) => Number((s ?? "").replace(",", "."));

function durationOf(text: string): number | undefined {
  const both = MINUTES_AND_SECONDS.exec(text);
  const minutes = both ? undefined : MINUTES.exec(text);
  const seconds = both || minutes ? undefined : SECONDS.exec(text);
  const ms = both
    ? (num(both[1]) * 60 + num(both[2])) * 1000
    : minutes
      ? num(minutes[1]) * 60_000
      : num(seconds?.[1]) * 1000;
  if (!Number.isFinite(ms) || ms < BRIEF_MIN_MS || ms > BRIEF_MAX_MS) return undefined;
  return Math.round(ms);
}

function ratioOfSize(text: string): AspectRatio | undefined {
  const size = /(?<![\d])(\d{3,4})\s*[x×]\s*(\d{3,4})(?![\d])/u.exec(text);
  if (!size) return undefined;
  const value = Number(size[1]) / Number(size[2]);
  return (Object.keys(RATIO_VALUE) as AspectRatio[]).find(
    (r) => Math.abs(value - RATIO_VALUE[r]) / RATIO_VALUE[r] <= 0.01,
  );
}

function aspectRatioOf(text: string): AspectRatio | undefined {
  const literal = /(?<![\d])(9:16|16:9|1:1)(?![\d])/u.exec(text)?.[1];
  if (literal) return literal as AspectRatio;
  const sized = ratioOfSize(text);
  if (sized) return sized;
  if (/(?<![\p{L}])(dọc|vertical|portrait|reels|shorts|tiktok)(?![\p{L}])/iu.test(text)) return "9:16";
  if (/(?<![\p{L}])(ngang|landscape|horizontal|widescreen|youtube)(?![\p{L}])/iu.test(text)) return "16:9";
  if (/(?<![\p{L}])(vuông|square)(?![\p{L}])/iu.test(text)) return "1:1";
  return undefined;
}

/** Read the length and aspect ratio a prompt states. */
export function promptFormatOf(prompt: string): PromptFormat {
  const text = prompt.normalize("NFC");
  const aspectRatio = aspectRatioOf(text);
  const durationMs = durationOf(text);
  return { ...(aspectRatio ? { aspectRatio } : {}), ...(durationMs ? { durationMs } : {}) };
}

/** The brief with the length and aspect ratio its prompt states filled in; explicit brief fields win. */
export function withPromptFormat(brief: CreativeBrief): CreativeBrief {
  if (brief.aspectRatio && brief.durationMs) return brief;
  const stated = promptFormatOf(brief.prompt);
  const aspectRatio = brief.aspectRatio ?? stated.aspectRatio;
  const durationMs = brief.durationMs ?? stated.durationMs;
  return { ...brief, ...(aspectRatio ? { aspectRatio } : {}), ...(durationMs ? { durationMs } : {}) };
}
