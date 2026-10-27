import { describe, expect, it } from "vitest";
import { OpenRouterAdapter } from "../src/index.ts";
import { ContractDecisionSchema, contractRequest } from "../src/testing/index.ts";

/**
 * Paid smoke test (collected only with STUDIX_LIVE=1). One tiny structured decision on a cheap model,
 * budget-capped at 1 cent by the adapter's own pre-call estimate; real spend is a fraction of that.
 */
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_LIVE_MODEL ?? "openai/gpt-4o-mini";

describe.skipIf(!apiKey)("OpenRouterAdapter (live)", () => {
  it("returns a schema-valid decision with usage and cost from OpenRouter", async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: apiKey!,
      model,
      baseUrl: process.env.OPENROUTER_BASE_URL,
      maxOutputTokens: 100,
      // Upper-bound prices for the estimate only; actual cost comes from OpenRouter's usage.cost.
      pricing: { inputCentsPerMillionTokens: 100, outputCentsPerMillionTokens: 400 },
      appName: "Studix live test",
    });
    const result = await adapter.decide(contractRequest({ budgetCents: 1, timeoutMs: 60_000 }));
    expect(ContractDecisionSchema.safeParse(result.output).success).toBe(true);
    expect(result.output.urgent).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.costCents).toBeGreaterThanOrEqual(0);
    expect(result.costCents).toBeLessThan(1);
  });
});
