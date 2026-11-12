import type { CreativeBrief } from "./creative-brief.ts";
import type { AspectRatio } from "./primitives.ts";

/**
 * The length and frame shape a free-form prompt states for the whole video, e.g. "a 60-second 16:9
 * (1920x1080) video" or "video dọc, tổng 1p30". Deterministic and offline, and deliberately conservative:
 * a part's length ("each 5 seconds"), a timecode ("0:15s"), a decade ("an 80s look"), an asset's size
 * ("our 1200x1200 logo") or a word like "portrait" on its own is not read as the video's format. A length
 * outside what a brief accepts (1 s to 10 min) is skipped.
 */
export interface PromptFormat {
  aspectRatio?: AspectRatio;
  durationMs?: number;
}

const BRIEF_MIN_MS = 1000;
const BRIEF_MAX_MS = 600_000;

/** A number that is not the tail of another number or of a timecode. */
const NUM = String.raw`(?<![\d.,:])(\d{1,3}(?:[.,]\d{1,2})?)`;
const GAP = String.raw`\s*-?\s*`;
const SECOND = "(?:giây|seconds?|secs?|s)";
const MINUTE = "(?:phút|minutes?|mins?)";
const END = String.raw`(?![\p{L}\d])`;
/** "the 80s", "'90s", "an 80s retro look", "80s-style". */
const NOT_DECADE = String.raw`(?<!(?:the|those)\s+|['’])`;
const DECADE_STYLE = String.raw`(?![\s-]+(?:retro|style|vibes?|look|aesthetics?|music|era|nostalgia|fashion|disco|synth|inspired))`;
/**
 * One length in any of its spellings, tried in this order at each position: minutes and seconds
 * ("1 minute and 30 seconds", "1m30s", "2 phút 30 giây"), Vietnamese "1p30", minutes, then seconds.
 */
const LENGTH = new RegExp(
  [
    `${NUM}${GAP}(?:${MINUTE}|m|p)\\s*(?:and\\s+|và\\s+)?${NUM}${GAP}${SECOND}${END}`,
    `${NUM}${GAP}(?:phút|p)\\s*${NUM}${END}`,
    `${NUM}${GAP}${MINUTE}${END}`,
    `${NOT_DECADE}${NUM}${GAP}${SECOND}${END}${DECADE_STYLE}`,
  ].join("|"),
  "giu",
);
/** Words just before a length that make it the whole video's ("total 30 seconds", "dài 6 giây"). */
const TOTAL_BEFORE =
  /(?:total|tổng|exactly|overall|in all|length|duration|thời lượng|dài|video|clip)[\s:]*(?:of\s+|là\s+|khoảng\s+|about\s+)?$/iu;
/** Words just after a length that make it the whole video's ("60-second video", "15s TikTok ad"). */
const TOTAL_AFTER =
  /^\s*(?:long\s+)?(?:video|clip|(?:\S+\s+)?(?:ad|advert|commercial|spot|film|teaser|trailer|promo|explainer|intro|reel|motion))(?![\p{L}])/iu;
/** Words just before a length that make it a part's ("each 5 seconds", "mỗi cảnh 3 giây", "last 3s"). */
const PART_BEFORE =
  /(?<![\p{L}])(?:each|per|every|mỗi|first|last|scene|shot|cảnh|phần|đoạn)(?![\p{L}])[^.,;!?\n]{0,12}$/iu;
/**
 * Words just after a length that make it a part's or the source's, never the video's: "5 seconds each",
 * "5s per scene", "5 giây một cảnh", "5 phút đầu", "10 minutes of footage".
 */
const PART_AFTER =
  /^\s*(?:each|apiece|per\s+\p{L}+|mỗi\s+\p{L}+|một\s+(?:cảnh|phần|đoạn|shot|scene)|đầu|cuối|of\s+(?:raw\s+)?(?:footage|video|recordings?|material|clips?)|(?:raw\s+)?footage|tư liệu|cảnh quay)(?![\p{L}])/iu;

const num = (s: string | undefined) => Number((s ?? "").replace(",", "."));

function durationOf(text: string): number | undefined {
  const lengths: Array<{ ms: number; total: boolean }> = [];
  for (const m of text.matchAll(LENGTH)) {
    const [, mm1, ss1, mm2, ss2, min, sec] = m;
    const ms =
      mm1 !== undefined
        ? (num(mm1) * 60 + num(ss1)) * 1000
        : mm2 !== undefined
          ? (num(mm2) * 60 + num(ss2)) * 1000
          : min !== undefined
            ? num(min) * 60_000
            : num(sec) * 1000;
    if (!Number.isFinite(ms) || ms < BRIEF_MIN_MS || ms > BRIEF_MAX_MS) continue;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (PART_AFTER.test(after)) continue;
    const total = TOTAL_BEFORE.test(before) || TOTAL_AFTER.test(after);
    // "our first 30-second ad" names the whole ad, though "first" usually opens a part.
    if (!total && PART_BEFORE.test(before)) continue;
    lengths.push({ ms: Math.round(ms), total });
  }
  return (lengths.find((l) => l.total) ?? lengths[0])?.ms;
}

const RATIO_VALUE: Record<AspectRatio, number> = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1 };
/** Edges of the video frame sizes people name; other sizes (a 1200x1200 logo) describe assets. */
const VIDEO_EDGES = new Set([480, 540, 720, 1080, 1280, 1440, 1920, 2160, 2560, 3840, 4096]);

function ratioOfSize(text: string): AspectRatio | undefined {
  for (const size of text.matchAll(/(?<![\d])(\d{3,4})\s*[x×]\s*(\d{3,4})(?![\d])/gu)) {
    const [w, h] = [Number(size[1]), Number(size[2])];
    if (!VIDEO_EDGES.has(w) || !VIDEO_EDGES.has(h)) continue;
    const ratio = (Object.keys(RATIO_VALUE) as AspectRatio[]).find(
      (r) => Math.abs(w / h - RATIO_VALUE[r]) / RATIO_VALUE[r] <= 0.01,
    );
    if (ratio) return ratio;
  }
  return undefined;
}

const FRAME_NOUN = "(?:video|clip|ad|intro|teaser|explainer|promo|format|frame|orientation|version|cut|mode)";
/** A length written between the orientation and the noun: "landscape 30-second intro". */
const LENGTH_BETWEEN = String.raw`(?:\d{1,3}[\s-]*(?:seconds?|secs?|s|minutes?|mins?)[\s-]+)?`;
/** A platform named between the orientation and the noun: "vertical TikTok ad". */
const PLATFORM = String.raw`(?:(?:tiktok|instagram|facebook|youtube|reels?|shorts|social)\s+)?`;
const VI_FRAME_NOUN = "(?:video|clip|quảng cáo|khung hình|khung|khổ|định dạng)";
/** An orientation tied to the frame: "vertical video", "in portrait", "video dọc", "khung ngang". */
const ORIENTATIONS: Array<[AspectRatio, RegExp]> = (
  [
    ["9:16", "vertical|portrait", "dọc"],
    // "ngang hàng" (on par) and "ngang qua" (passing by) do not name the frame.
    ["16:9", "landscape|horizontal|widescreen", "ngang(?!\\s+(?:hàng|qua|nhiên|tầm|bằng|ngửa))"],
    ["1:1", "square", "vuông"],
  ] as const
).flatMap(([ratio, en, vi]) => [
  [
    ratio,
    new RegExp(`(?<![\\p{L}])(?:${en})[\\s-]+${LENGTH_BETWEEN}${PLATFORM}${FRAME_NOUN}(?![\\p{L}])`, "iu"),
  ],
  // Case-sensitive: "Pay in Square" names a company.
  [ratio, new RegExp(`(?<![\\p{L}])[Ii]n\\s+(?:${en})(?![\\p{L}])`, "u")],
  [ratio, new RegExp(`(?<![\\p{L}])${VI_FRAME_NOUN}\\s+${vi}(?![\\p{L}])`, "iu")],
]);

/** The orientation stated first in the prompt. */
function orientationOf(text: string): AspectRatio | undefined {
  let best: { at: number; ratio: AspectRatio } | undefined;
  for (const [ratio, re] of ORIENTATIONS) {
    const at = re.exec(text)?.index;
    if (at !== undefined && (!best || at < best.at)) best = { at, ratio };
  }
  return best?.ratio;
}

/** "1:1 coaching" names a kind of meeting, not a frame. */
const NOT_SQUARE_FRAME = /^\s+(?:coaching|meetings?|sessions?|calls?|mentoring|support|chats?|tư vấn)/iu;

function aspectRatioOf(text: string): AspectRatio | undefined {
  for (const m of text.matchAll(/(?<![\d])(9:16|16:9|1:1)(?![\d])/gu)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (m[1] === "1:1" && NOT_SQUARE_FRAME.test(after)) continue;
    return m[1] as AspectRatio;
  }
  return ratioOfSize(text) ?? orientationOf(text);
}

/** Read the length and aspect ratio a prompt states for the whole video. */
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
