import type { KnowledgeSource } from "./knowledge-pack-schema.ts";
import { PINNED_SOURCES } from "./knowledge-sources.ts";

export interface KnowledgeLintConfig {
  /**
   * Names that must not appear in pack content (source refs excepted): existing films, series and studios,
   * and real brands that source style aliases used. Matched case-insensitively on word boundaries.
   */
  bannedTerms: readonly string[];
  /** The only commit each source repository may be cited at. */
  pinnedSources: Readonly<Record<KnowledgeSource["repo"], string>>;
}

/**
 * Default deny-list. It names IP so the lint can keep it out of packs; extend it when a new source brings
 * new names. Words that are also ordinary English ("notion", "linear", "slack", "stripe") are left out on purpose:
 * a false positive on craft text costs more than the review that catches them.
 */
export const DEFAULT_BANNED_TERMS: readonly string[] = [
  // Films, series and studios named by the anime-creator source.
  "ufotable",
  "Demon Slayer",
  "Kimetsu",
  "FRONTIER",
  // Studios, franchises and streaming brands that style references tend to borrow.
  "Netflix",
  "Pixar",
  "Disney",
  "Ghibli",
  "DreamWorks",
  "Marvel",
  "Spider-Verse",
  "Spiderverse",
  // Brands the source style profiles used as aliases (migration matrix MV-14).
  "Nvidia",
  "OpenAI",
  "Anthropic",
  "Nike",
  "Adidas",
  "Duolingo",
  "Apple",
  "iPhone",
  "Sony",
  "PlayStation",
  "Nintendo",
  "Discord",
  "Figma",
  "Adobe",
  "GitHub",
  "Patagonia",
  "Red Bull",
  "Microsoft",
  "Google",
  "IKEA",
  "Airbnb",
  "Coca-Cola",
  "Tesla",
  "SpaceX",
  "LEGO",
  "Vercel",
  "Spotify",
  "DJI",
  "Mailchimp",
  "Samsung",
  "IBM",
  "TikTok",
  "FigJam",
  "Creative Cloud",
  "Material You",
  "Redbull",
  "Coca Cola",
  "Next.js",
  "Nextjs",
  // Company-named typefaces and trademarks the source profiles used in their bodies.
  "JetBrains",
  "Polaroid",
  "blurple",
];

export const DEFAULT_KNOWLEDGE_LINT_CONFIG: KnowledgeLintConfig = {
  bannedTerms: DEFAULT_BANNED_TERMS,
  pinnedSources: PINNED_SOURCES,
};
