import { StudixError } from "@studix/shared";
import type { TokenUsage } from "./decision-types.ts";

/** Per-model token prices in cents per million tokens (configuration, never hardcoded per vendor). */
export interface TokenPricing {
  inputCentsPerMillionTokens: number;
  outputCentsPerMillionTokens: number;
}

/** Conservative token estimate for budget checks: ~4 characters per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function costFromUsage(usage: TokenUsage, pricing: TokenPricing | undefined): number {
  if (!pricing) return 0;
  return (
    (usage.inputTokens * pricing.inputCentsPerMillionTokens +
      usage.outputTokens * pricing.outputCentsPerMillionTokens) /
    1_000_000
  );
}

export function assertPricing(pricing: TokenPricing | undefined, provider: string): void {
  if (!pricing) return;
  for (const value of [pricing.inputCentsPerMillionTokens, pricing.outputCentsPerMillionTokens]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new StudixError("VALIDATION", `${provider} pricing must be finite numbers >= 0`);
    }
  }
}

export function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
