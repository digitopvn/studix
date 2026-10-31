import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { createClaudeAgentRuntime, createClaudeSdkQuery } from "../src/index.ts";

/** Paid: runs one tiny real agent call. Collected only with STUDIX_LIVE=1 and ANTHROPIC_API_KEY. */
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("claude agent runtime (live)", () => {
  it("returns structured output within the budget", async () => {
    const runtime = createClaudeAgentRuntime({
      model: process.env.STUDIX_CLAUDE_MODEL ?? "claude-haiku-5-5",
      query: createClaudeSdkQuery(),
      resolveCredential: async () => ({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    });
    const result = await runtime.run(testTenant(), {
      skill: "live-smoke",
      instructions: "Return the word ok in the answer field.",
      input: {},
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
      maxCostCents: 20,
      maxTurns: 3,
      deadlineAt: new Date(Date.now() + 120_000),
    });
    expect(result.costCents).toBeLessThanOrEqual(20);
    expect(result.output).toMatchObject({ answer: expect.any(String) });
  });
});
