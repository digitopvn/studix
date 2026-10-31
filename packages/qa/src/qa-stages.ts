import type { ApprovalAction } from "@studix/core";
import type { StageContext, StageDefinition } from "@studix/workflow";
import { assertHumanReview, humanReviewVerdict, QA_REVIEW_ACTION } from "./human-review.ts";
import { defaultHardChecks, type QaMetricCheck } from "./qa-checks.ts";
import { assertHardGate, collectEvidence, type EvidenceRequest, type QaGateRunOptions, runHardGate } from "./qa-gates.ts";

export interface QaStagesOptions {
  /** Stage name prefix: `<prefix>_check` and `<prefix>_review`. Defaults to "qa". */
  prefix?: string;
  /** Local path of the file to check, usually from a render stage's checkpoint. */
  file(stage: StageContext): string | Promise<string>;
  /** Hard and evidence checks; defaults to defaultHardChecks(). */
  checks?(stage: StageContext): readonly QaMetricCheck[] | Promise<readonly QaMetricCheck[]>;
  /** Evidence to gather after the hard gate passed. */
  evidence?(stage: StageContext): EvidenceRequest | undefined | Promise<EvidenceRequest | undefined>;
  /** Toolchain, timeouts and sandbox root; the stage's abort signal is added per run. */
  run: QaGateRunOptions;
  /** The human layer: the approval action the review stage waits for; false leaves it out. */
  review?: { action?: ApprovalAction } | false;
}

/**
 * The QA layers as workflow stages.
 *
 * `<prefix>_check` runs the hard gate and throws a non-retryable VALIDATION error when a hard check fails, which
 * fails the stage and stops the job before anything downstream (upload, publish) runs. It then records evidence,
 * which never blocks. `<prefix>_review` is gated by the engine's approval gate (the job parks until a person
 * decides) and checks again that the approval is a human one.
 *
 * The check stage has no cache key on purpose: it measures a worker-local file.
 */
export function createQaStages(options: QaStagesOptions): StageDefinition[] {
  const prefix = options.prefix ?? "qa";
  const check: StageDefinition = {
    name: `${prefix}_check`,
    async run(s) {
      const file = await options.file(s);
      const checks = (await options.checks?.(s)) ?? defaultHardChecks();
      const run = { ...options.run, signal: s.signal };
      const hard = await runHardGate(file, checks, run);
      assertHardGate(hard);
      const request = await options.evidence?.(s);
      const evidence = request ? await collectEvidence(file, { checks, ...request }, run) : undefined;
      return {
        output: {
          hard: { pass: hard.pass, checks: hard.checks, measurements: hard.measurements },
          ...(evidence && { evidence }),
        },
      };
    },
  };
  if (options.review === false) return [check];
  const action = options.review?.action ?? QA_REVIEW_ACTION;
  const review: StageDefinition = {
    name: `${prefix}_review`,
    // No cost estimate: a policy that gates by cost treats the action as unknown cost and requires approval.
    approval: { action },
    async run(s) {
      const approval = assertHumanReview(
        humanReviewVerdict(s.approval, { action, subject: { type: "job", id: s.job.id } }),
      );
      return {
        output: { approvalId: approval.id, approvedBy: approval.decidedBy?.id ?? null, comment: approval.comment ?? null },
      };
    },
  };
  return [check, review];
}
