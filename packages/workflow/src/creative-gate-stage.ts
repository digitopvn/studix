import { StudixError } from "@studix/shared";
import { z } from "zod";
import type { StageDefinition } from "./workflow-types.ts";

/** Gate id inside a job: `G0`, `G1`, ... (scope `gate:<id>` of its `creative.gate` approval). */
const GateId = z.string().regex(/^G[0-9]{1,2}$/, "expected a gate id such as G0");

export const CreativeGateOutput = z.object({
  gate: GateId,
  approvalId: z.string().min(1),
  decidedBy: z.string().min(1),
  decidedAt: z.string().min(1),
});
export type CreativeGateOutput = z.infer<typeof CreativeGateOutput>;

/** Approval scope of a creative gate. */
export const creativeGateScope = (gate: string): string => `gate:${gate}`;

export interface CreativeGateOptions {
  /** Gate id (`G0`, `G1`, ...); unique within the workflow. */
  gate: string;
  /** Stage name; defaults to `gate.<id>` in lower case. */
  name?: string;
  /** What the reviewer signs off, shown on the approval request. */
  summary: string;
}

/**
 * A human sign-off between creative stages, built on the approval mechanism: the job parks with a
 * `creative.gate` request scoped `gate:<id>` (always required, whatever it costs), resumes once a signed-in
 * person approves it, and fails when they reject it. The decision is checkpointed, so a resumed job never
 * asks again. It has no cache key: every job asks its own reviewer.
 */
export function createCreativeGateStage(options: CreativeGateOptions): StageDefinition {
  const gate = GateId.parse(options.gate);
  return {
    name: options.name ?? `gate.${gate.toLowerCase()}`,
    outputSchema: CreativeGateOutput,
    approval: {
      action: "creative.gate",
      scopeKey: creativeGateScope(gate),
      reason: `${gate}: ${options.summary}`,
    },
    retry: "never",
    async run(s) {
      const approval = s.approval;
      if (approval?.status !== "approved" || approval.decidedBy?.type !== "user") {
        // The default policy always requires creative gates; a policy that waives one is a misconfiguration.
        throw new StudixError("APPROVAL_REQUIRED", `${gate} needs a person's approval`, {
          retryable: false,
          details: { gate },
          suggestedAction: "Keep creative.gate in the approval policy's always-required actions.",
        });
      }
      const output: CreativeGateOutput = {
        gate,
        approvalId: approval.id,
        decidedBy: approval.decidedBy.id,
        decidedAt: (approval.decidedAt ?? new Date()).toISOString(),
      };
      return { output };
    },
  };
}
