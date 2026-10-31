import type { AgentStageLimits, ApprovalAction } from "@studix/core";
import type { StudixError } from "@studix/shared";
import type { StageUsage } from "./workflow-types.ts";

/** The stage cannot finish now and the job parks until a person, or the host agent, acts. */
export type StageSuspension =
  | {
      kind: "approval";
      action: ApprovalAction;
      /** Scope of the request; `agent:<stage>` for agent overruns. */
      scopeKey: string;
      reason: string;
      estimatedCostCents?: number;
    }
  | {
      kind: "host";
      /** The task handed to the host agent; the runner adds the job, attempt and expiry. */
      task: {
        round: number;
        instructions: string;
        input: Record<string, unknown>;
        outputSchema: Record<string, unknown>;
        limits: AgentStageLimits;
      };
    };

/**
 * Thrown by a stage to park the job instead of failing it. `usage` is what the stage already spent (an
 * agent stopped at a cap still paid for its tokens); the runner records it before parking.
 */
export class StageSuspended extends Error {
  constructor(
    readonly suspension: StageSuspension,
    readonly usage: StageUsage[] = [],
  ) {
    super(suspension.kind === "approval" ? suspension.reason : "stage waits for the host agent");
    this.name = "StageSuspended";
  }
}

/** Thrown by a stage that failed after it spent money: the runner records `usage`, then fails with `error`. */
export class StageFailedAfterSpend extends Error {
  constructor(
    readonly error: StudixError,
    readonly usage: StageUsage[],
  ) {
    super(error.message, { cause: error });
    this.name = "StageFailedAfterSpend";
  }
}

/** A fenced write was refused: another worker owns the job now, so this attempt must stop writing. */
export class LeaseLostError extends Error {
  constructor() {
    super("Job lease was lost to another worker");
    this.name = "LeaseLostError";
  }
}
