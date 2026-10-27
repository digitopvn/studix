import { describe, expect, it } from "vitest";
import { TypeSafeAIAdapter } from "../src/index.ts";
import { ContractDecisionSchema, contractRequest } from "../src/testing/index.ts";

/**
 * Paid smoke test (collected only with STUDIX_LIVE=1, skipped without TYPESAFE_API_KEY). Verifies the
 * real System One endpoint, auth and answer shapes against the documented contract with two questions.
 */
const apiKey = process.env.TYPESAFE_API_KEY;

describe.skipIf(!apiKey)("TypeSafeAIAdapter (live)", () => {
  it("answers a choice + noul decision through the System One API", async () => {
    const adapter = new TypeSafeAIAdapter({
      apiKey: apiKey!,
      model: process.env.TYPESAFE_DECISION_MODEL,
      baseUrl: process.env.TYPESAFE_BASE_URL,
    });
    const result = await adapter.decide(contractRequest({ budgetCents: 1, timeoutMs: 60_000 }));
    expect(ContractDecisionSchema.safeParse(result.output).success).toBe(true);
    expect(result.output.urgent).toBe(true);
    expect(result.model).toEqual(expect.any(String));
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});
