import type { CreativeBrief } from "@studix/video-ir";
import { dedupeKey, normalizeText, truncateText } from "../vietnamese-safe-text.ts";

/** Longest on-screen key message; longer copy is cut at a space so a scene stays readable in ~3s. */
export const MAX_MESSAGE_CHARS = 120;
const MAX_TITLE_CHARS = 80;
const MAX_CTA_CHARS = 60;
const MAX_WORDMARK_CHARS = 60;

interface TemplateStrings {
  cta: string;
  audience: (audience: string) => string;
  generic: ((name: string) => string)[];
}

/** Template defaults per language family; anything other than Vietnamese uses English. */
const STRINGS: Record<"vi" | "en", TemplateStrings> = {
  vi: {
    cta: "Tìm hiểu thêm",
    audience: (a) => `Dành cho ${a}`,
    generic: [(n) => `Khám phá ${n}`, (n) => `Trải nghiệm khác biệt cùng ${n}`, (n) => `${n} luôn sẵn sàng`],
  },
  en: {
    cta: "Learn more",
    audience: (a) => `Made for ${a}`,
    generic: [
      (n) => `Discover ${n}`,
      (n) => `Experience the difference with ${n}`,
      (n) => `${n} is ready for you`,
    ],
  },
};

export interface BrandIntroCopy {
  /** IR document title (not shown on screen). */
  documentTitle: string;
  title: string;
  subtitle?: string;
  messages: string[];
  cta: string;
  /** Brand wordmark for the outro, when the brief names a brand. */
  wordmark?: string;
  /** How many messages came from template defaults rather than the brief. */
  filledMessages: number;
  /** Distinct brief messages that did not fit the scene budget. */
  droppedMessages: number;
}

function firstSentence(text: string): string {
  const clean = normalizeText(text);
  const end = clean.search(/[.!?…](\s|$)/u);
  return end > 0 ? clean.slice(0, end) : clean;
}

/**
 * Pick the on-screen copy. Brief copy always wins; template defaults only fill the minimum of two key
 * messages. The prompt is an instruction to the planner, so it is used only as a last-resort title.
 */
export function selectBrandIntroCopy(
  brief: CreativeBrief,
  language: string,
  maxMessages: number,
): BrandIntroCopy {
  const strings = STRINGS[language.startsWith("vi") ? "vi" : "en"];
  const brandName = brief.brand ? normalizeText(brief.brand.name) : undefined;
  const titleSource = brief.title ?? brandName ?? firstSentence(brief.prompt);
  const name = brandName ?? truncateText(titleSource, MAX_TITLE_CHARS);
  const tagline = brief.brand?.tagline ? normalizeText(brief.brand.tagline) : "";

  const seen = new Set<string>([dedupeKey(tagline, language), dedupeKey(titleSource, language)]);
  const messages: string[] = [];
  let dropped = 0;
  const offer = (text: string) => {
    const clean = normalizeText(text);
    const key = dedupeKey(clean, language);
    if (!clean || seen.has(key)) return;
    seen.add(key);
    if (messages.length >= maxMessages) {
      dropped++;
      return;
    }
    messages.push(truncateText(clean, MAX_MESSAGE_CHARS));
  };
  for (const message of brief.keyMessages ?? []) offer(message);
  const fromBrief = messages.length;
  if (messages.length < 2 && brief.audience?.trim())
    offer(strings.audience(truncateText(brief.audience, 60)));
  for (const line of strings.generic) if (messages.length < 2) offer(line(name));

  return {
    documentTitle: truncateText(titleSource, 200),
    title: truncateText(titleSource, MAX_TITLE_CHARS),
    ...(tagline ? { subtitle: truncateText(tagline, 160) } : {}),
    messages,
    cta: truncateText(brief.callToAction?.trim() ? brief.callToAction : strings.cta, MAX_CTA_CHARS),
    ...(brandName ? { wordmark: truncateText(brandName, MAX_WORDMARK_CHARS) } : {}),
    filledMessages: messages.length - fromBrief,
    droppedMessages: dropped,
  };
}
