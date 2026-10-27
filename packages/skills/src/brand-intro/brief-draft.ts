import {
  AspectRatio,
  type BrandFonts,
  type BrandPalette,
  type CreativeBrief,
  HexColor,
  LanguageTag,
  unwrapValidation,
  validateCreativeBrief,
} from "@studix/video-ir";
import { z } from "zod";
import { BRAND_INTRO_MAX_MS, BRAND_INTRO_MIN_MS } from "./brand-intro-template.ts";

/**
 * Compact brief a planner extracts from a free-form prompt (by a model or by the deterministic rules in
 * brief-draft-from-prompt.ts). Small and flat so it doubles as the structured-output schema of the
 * `video.brief` decision; applyBriefDraft maps it onto a full CreativeBrief.
 */
export const BriefDraft = z.object({
  /** On-screen title; defaults to the brand name. */
  title: z.string().trim().min(1).max(200).optional(),
  brandName: z.string().trim().min(1).max(120).optional(),
  tagline: z.string().trim().min(1).max(200).optional(),
  /** Short on-screen messages in the prompt's language, most important first. */
  keyMessages: z.array(z.string().trim().min(1).max(300)).max(5),
  callToAction: z.string().trim().min(1).max(200).optional(),
  audience: z.string().trim().min(1).max(500).optional(),
  /** BCP 47 tag of the prompt's language, e.g. "vi" or "en". */
  language: LanguageTag.optional(),
  aspectRatio: AspectRatio.optional(),
  durationMs: z.number().int().min(BRAND_INTRO_MIN_MS).max(BRAND_INTRO_MAX_MS).optional(),
  palette: z
    .object({
      primary: HexColor,
      accent: HexColor.optional(),
      background: HexColor.optional(),
      foreground: HexColor.optional(),
    })
    .optional(),
});
export type BriefDraft = z.infer<typeof BriefDraft>;

/** Brand colors used when neither the brief nor the draft supplies any (light text on a dark stage). */
export const DEFAULT_BRAND_PALETTE: BrandPalette = {
  primary: "#2563EB",
  accent: "#F59E0B",
  background: "#0B1020",
  foreground: "#F8FAFC",
};

/** Fonts the renderer bundles; both cover Vietnamese diacritics. */
export const DEFAULT_BRAND_FONTS: BrandFonts = { heading: "Be Vietnam Pro", body: "Be Vietnam Pro" };

/** A brief that carries only a prompt (plus format hints) and needs a draft before templating. */
export function needsBriefDraft(brief: CreativeBrief): boolean {
  return !brief.brand && !(brief.keyMessages && brief.keyMessages.length > 0);
}

/**
 * Fill the brief's missing fields from a draft. Anything the user set in the brief wins; the draft only
 * fills gaps. The result is validated as a CreativeBrief (VALIDATION StudixError on failure).
 */
export function applyBriefDraft(brief: CreativeBrief, draft: BriefDraft): CreativeBrief {
  const brand =
    brief.brand ??
    (draft.brandName
      ? {
          name: draft.brandName,
          ...(draft.tagline ? { tagline: draft.tagline } : {}),
          palette: { ...DEFAULT_BRAND_PALETTE, ...draft.palette },
          fonts: DEFAULT_BRAND_FONTS,
        }
      : undefined);
  const keyMessages = brief.keyMessages?.length ? brief.keyMessages : draft.keyMessages;
  const merged: CreativeBrief = {
    ...brief,
    ...(brief.title || !draft.title ? {} : { title: draft.title }),
    ...(brief.language || !draft.language ? {} : { language: draft.language }),
    ...(keyMessages.length > 0 ? { keyMessages } : {}),
    ...(brief.callToAction || !draft.callToAction ? {} : { callToAction: draft.callToAction }),
    ...(brief.audience || !draft.audience ? {} : { audience: draft.audience }),
    ...(brief.aspectRatio || !draft.aspectRatio ? {} : { aspectRatio: draft.aspectRatio }),
    ...(brief.durationMs || !draft.durationMs ? {} : { durationMs: draft.durationMs }),
    ...(brand ? { brand } : {}),
  };
  return unwrapValidation(validateCreativeBrief(merged), "creative brief");
}
