import { createHash } from "node:crypto";

/** Brand facts returned by the mock `brand_lookup` tool (stand-in for a real brand/asset service). */
export interface BrandProfile {
  name: string;
  tagline: string;
  colors: { primary: string; secondary: string; accent: string };
  tone: string;
  source: "catalog" | "generated";
}

const CATALOG: Record<string, Omit<BrandProfile, "name" | "source">> = {
  "suong mai": {
    tagline: "Đánh thức buổi sáng",
    colors: { primary: "#5B3A29", secondary: "#F3E6D3", accent: "#C8873A" },
    tone: "warm, calm, morning ritual",
  },
  digitop: {
    tagline: "Build what matters",
    colors: { primary: "#111827", secondary: "#F9FAFB", accent: "#6366F1" },
    tone: "confident, technical, friendly",
  },
};

/** Lowercase, strip Vietnamese diacritics and collapse whitespace so lookups are forgiving. */
export function normalizeBrandName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function hexFrom(seed: Buffer, offset: number): string {
  return `#${seed
    .subarray(offset, offset + 3)
    .toString("hex")
    .toUpperCase()}`;
}

/** Known brands come from the catalog; unknown names get a deterministic generated palette. */
export function lookupBrand(name: string): BrandProfile {
  const known = CATALOG[normalizeBrandName(name)];
  if (known) return { name, ...known, source: "catalog" };
  const seed = createHash("sha256").update(normalizeBrandName(name)).digest();
  return {
    name,
    tagline: `${name.trim()}, made simple`,
    colors: { primary: hexFrom(seed, 0), secondary: hexFrom(seed, 3), accent: hexFrom(seed, 6) },
    tone: "neutral",
    source: "generated",
  };
}
