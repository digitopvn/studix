import type { StudixErrorPayload } from "@studix/shared";
import type { TenantContext } from "../tenant.ts";

export interface ExecutionTask {
  jobId: string;
  kind: string;
  payload: Record<string, unknown>;
  deadlineAt?: Date;
  signal?: AbortSignal;
}

export type ExecutionOutcome =
  | { status: "succeeded"; output: Record<string, unknown> }
  | { status: "failed"; error: StudixErrorPayload }
  | { status: "cancelled" };

/** Where a job's heavy work executes (in-process worker today, isolated pods later). */
export interface ExecutionBackend {
  readonly id: string;
  /** Number of additional tasks this backend can accept right now. */
  availableSlots(): number;
  execute(ctx: TenantContext, task: ExecutionTask): Promise<ExecutionOutcome>;
}
