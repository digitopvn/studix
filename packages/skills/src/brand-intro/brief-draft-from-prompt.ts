import type { AspectRatio } from "@studix/video-ir";
import { detectLanguage, normalizeText, truncateText } from "../vietnamese-safe-text.ts";
import { BRAND_INTRO_MAX_MS, BRAND_INTRO_MIN_MS } from "./brand-intro-template.ts";
import { BriefDraft } from "./brief-draft.ts";

/**
 * Deterministic prompt -> BriefDraft extraction: the free, offline fallback of the `video.brief` decision.
 * Heuristics only (no model), tuned for short Vietnamese and English briefs such as
 * "Video giới thiệu thương hiệu cà phê Sương Mai, dài 6 giây. Rang mới mỗi tuần. Đặt ngay hôm nay!".
 * Text is NFC-normalized but never ASCII-folded, so diacritics survive intact.
 */

const MAX_MESSAGES = 3;
const MESSAGE_CHARS = 120;
const BRAND_MAX_WORDS = 5;

/** Capitalized words that name formats or platforms rather than the brand. */
const NOT_BRAND = new Set(
  [
    "video",
    "clip",
    "intro",
    "outro",
    "tiktok",
    "youtube",
    "facebook",
    "instagram",
    "reels",
    "shorts",
    "story",
  ].map((w) => w.toLocaleLowerCase()),
);
const CTA_START =
  /^(đặt|mua|liên hệ|ghé|truy cập|đăng ký|gọi|nhắn|tải|thử|khám phá ngay|order|buy|visit|try|call|shop|get|sign up|download|book|join|learn more)(?![\p{L}])/iu;
const DURATION = /(\d{1,3})\s*(?:giây|seconds?|secs?|s)(?![\p{L}])/iu;
const DIRECTIVE_ONLY =
  /^(?:(?:dài|thời lượng|length|duration|khoảng|about|tỉ lệ|tỷ lệ|định dạng|format|video|clip)\s*:?\s*)*[\d\s:]+(?:giây|seconds?|secs?|s)?\.?$/iu;
const AUDIENCE =
  /(?:dành cho|cho|for|targeting)\s+((?:khách hàng|người|giới|bạn|các|gia đình|sinh viên|dân|young|customers|people|students|families|parents|teens|professionals)[^,.;!?\n]{0,60})/iu;
const QUOTED = /["“«]([^"”»\n]{2,60})["”»]/u;
const BRAND_KEYWORD = /(?:thương hiệu|nhãn hàng|brand)\s+([^,.;!?\n]{2,60})/iu;

function aspectRatioOf(text: string): AspectRatio | undefined {
  const literal = /(?<![\d])(9:16|16:9|1:1)(?![\d])/u.exec(text)?.[1];
  if (literal) return literal as AspectRatio;
  if (/(?<![\p{L}])(dọc|vertical|portrait|reels|shorts|tiktok)(?![\p{L}])/iu.test(text)) return "9:16";
  if (/(?<![\p{L}])(ngang|landscape|horizontal|widescreen|youtube)(?![\p{L}])/iu.test(text)) return "16:9";
  if (/(?<![\p{L}])(vuông|square)(?![\p{L}])/iu.test(text)) return "1:1";
  return undefined;
}

function durationOf(text: string): number | undefined {
  const seconds = Number(DURATION.exec(text)?.[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(BRAND_INTRO_MAX_MS, Math.max(BRAND_INTRO_MIN_MS, seconds * 1000));
}

const stripEdgePunctuation = (word: string) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}&'’]+$/gu, "");

/** First run of capitalized words that does not open the sentence (where any word is capitalized). */
function capitalizedRun(sentence: string): string | undefined {
  const words = sentence.split(" ");
  let run: string[] = [];
  const flush = () => {
    const found = run.length > 0 && run.length <= BRAND_MAX_WORDS ? run.join(" ") : undefined;
    run = [];
    return found;
  };
  for (let i = 1; i < words.length; i++) {
    const raw = words[i]!;
    const word = stripEdgePunctuation(raw);
    const capitalized = /^\p{Lu}/u.test(word) && !NOT_BRAND.has(word.toLocaleLowerCase());
    if (capitalized) run.push(word);
    // A clause boundary right after the word ends the run.
    if (!capitalized || /[,;:!?.]$/u.test(raw)) {
      const found = flush();
      if (found) return found;
    }
  }
  return flush();
}

function brandNameOf(sentences: string[]): string | undefined {
  const all = sentences.join(" ");
  const quoted = QUOTED.exec(all)?.[1]?.trim();
  if (quoted) return quoted;
  for (const sentence of sentences) {
    const run = capitalizedRun(sentence);
    if (run) return run;
  }
  const keyword = BRAND_KEYWORD.exec(sentences[0] ?? "")?.[1];
  return keyword ? truncateText(keyword, 60) : undefined;
}

/** Split into sentences and list items, dropping bullets and empty lines. */
function sentencesOf(prompt: string): string[] {
  return prompt
    .normalize("NFC")
    .split(/\n+|(?<=[.!?…])\s+/u)
    .map((s) => normalizeText(s.replace(/^\s*(?:[-•*]|\d+[.)])\s+/u, "")))
    .filter((s) => s.length > 0);
}

const withoutFinalPeriod = (s: string) => s.replace(/\.+$/u, "").trim();

/** Extract a BriefDraft from a free-form prompt. Pure and deterministic. */
export function draftBriefFromPrompt(prompt: string): BriefDraft {
  const sentences = sentencesOf(prompt);
  const [first = "", ...afterFirst] = sentences;
  // "Make a video for X: point one, point two." carries its messages after the colon.
  const colon = first.indexOf(":");
  const instruction = colon > 0 ? first.slice(0, colon) : first;
  const inlineItems =
    colon > 0
      ? first
          .slice(colon + 1)
          .split(/[,;]/u)
          .map((item) => normalizeText(item))
          .filter((item) => item.length > 0)
      : [];
  const rest = [...inlineItems, ...afterFirst];
  const brandName = brandNameOf(sentences);
  const audience = AUDIENCE.exec(instruction)?.[1]?.trim();
  let callToAction: string | undefined;
  const keyMessages: string[] = [];
  for (const sentence of rest) {
    if (DIRECTIVE_ONLY.test(sentence)) continue;
    if (!callToAction && CTA_START.test(sentence)) {
      callToAction = truncateText(withoutFinalPeriod(sentence), 60);
      continue;
    }
    if (keyMessages.length < MAX_MESSAGES)
      keyMessages.push(truncateText(withoutFinalPeriod(sentence), MESSAGE_CHARS));
  }
  const aspectRatio = aspectRatioOf(prompt);
  const durationMs = durationOf(prompt);
  return BriefDraft.parse({
    ...(brandName ? { title: brandName, brandName } : {}),
    keyMessages,
    ...(callToAction ? { callToAction } : {}),
    ...(audience ? { audience: truncateText(audience, 80) } : {}),
    language: detectLanguage(prompt),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(durationMs ? { durationMs } : {}),
  });
}
