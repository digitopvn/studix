import type { TenantContext } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createLogger, type Logger, newId } from "@studix/shared";
import { z } from "zod";
import type { DecisionRequest } from "../decision-types.ts";

/** Small decision used by the contract suite: flat enum + boolean, answerable by every provider type. */
export const ContractDecisionSchema = z.object({
  route: z.enum(["render", "review", "reject"]).describe("Where the draft goes next"),
  urgent: z.boolean().describe("Whether the client marked the request as urgent"),
});
export type ContractDecision = z.infer<typeof ContractDecisionSchema>;

export const CONTRACT_KIND = "qa.route";
export const CONTRACT_VALID_OUTPUT: ContractDecision = { route: "render", urgent: true };
/** Output a provider might return that violates the schema; it must never surface as a result. */
export const CONTRACT_INVALID_OUTPUT = { route: "teleport", urgent: "very" };
export const CONTRACT_INPUT = {
  draft: "30s brand intro, all shots approved",
  note: "Client says: please hurry, launch is tomorrow.",
};

export function contractRequest(
  overrides: Partial<DecisionRequest<ContractDecision>> & { tenant?: TenantContext } = {},
): DecisionRequest<ContractDecision> {
  return {
    kind: CONTRACT_KIND,
    tenant: testTenant(),
    input: CONTRACT_INPUT,
    schema: ContractDecisionSchema,
    instructions: "Route the QA'd draft and flag urgency.",
    budgetCents: 5,
    timeoutMs: 5_000,
    idempotencyKey: newId("dec"),
    ...overrides,
  };
}

/** Logger that keeps every emitted (already redacted) JSON line for assertions. */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: createLogger({}, { level: "debug", write: (line) => lines.push(line) }), lines };
}
