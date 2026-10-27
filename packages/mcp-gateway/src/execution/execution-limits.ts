import { type Clock, StudixError, systemClock } from "@studix/shared";
import type { GatewayCallContext } from "./gateway-call-context.ts";

/**
 * Per-workspace concurrency cap for downstream executes in this process. Over-cap calls are rejected
 * immediately with RATE_LIMITED (retryable) instead of queueing behind slow third-party servers.
 */
export class WorkspaceConcurrencyLimiter {
  private readonly active = new Map<string, number>();

  constructor(private readonly maxPerWorkspace: number) {
    if (!Number.isInteger(maxPerWorkspace) || maxPerWorkspace < 1) {
      throw new RangeError("maxPerWorkspace must be a positive integer");
    }
  }

  /** Take a slot or throw RATE_LIMITED. The returned release function is idempotent. */
  acquire(workspaceId: string): () => void {
    const current = this.active.get(workspaceId) ?? 0;
    if (current >= this.maxPerWorkspace) {
      throw new StudixError("RATE_LIMITED", "Too many concurrent connector calls in this workspace", {
        retryable: true,
        suggestedAction: "Wait for running connector calls to finish, then retry.",
        details: { limit: this.maxPerWorkspace },
      });
    }
    this.active.set(workspaceId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.active.get(workspaceId) ?? 1) - 1;
      if (left <= 0) this.active.delete(workspaceId);
      else this.active.set(workspaceId, left);
    };
  }

  inFlight(workspaceId: string): number {
    return this.active.get(workspaceId) ?? 0;
  }
}

/** Budget check run before every downstream execute; throw BUDGET_EXCEEDED or RATE_LIMITED to refuse. */
export interface GatewayBudget {
  reserve(call: GatewayCallContext, qualifiedTool: string): Promise<void>;
}

export interface CallBudgetOptions {
  /** Max downstream calls per job (default 100). */
  maxCallsPerJob?: number;
  /** Max downstream calls per workspace per rolling minute (default 120). */
  maxCallsPerMinute?: number;
  clock?: Clock;
}

/**
 * Default call-count budget (connector calls carry no metered cost in P0). In-process only; the workflow
 * package can plug in a Postgres-backed budget through the same interface.
 */
export function createCallBudget(options: CallBudgetOptions = {}): GatewayBudget {
  const perJob = options.maxCallsPerJob ?? 100;
  const perMinute = options.maxCallsPerMinute ?? 120;
  const clock = options.clock ?? systemClock;
  const jobCalls = new Map<string, number>();
  const windows = new Map<string, number[]>();
  return {
    async reserve(call) {
      const now = clock.now().getTime();
      const ws = call.tenant.workspaceId;
      const recent = (windows.get(ws) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= perMinute) {
        throw new StudixError("RATE_LIMITED", "Workspace connector call rate exceeded", {
          retryable: true,
          details: { limitPerMinute: perMinute },
        });
      }
      if (call.jobId) {
        const key = `${ws}:${call.jobId}`;
        const used = jobCalls.get(key) ?? 0;
        if (used >= perJob) {
          throw new StudixError("BUDGET_EXCEEDED", "Job connector call budget exhausted", {
            retryable: false,
            details: { limit: perJob },
          });
        }
        jobCalls.set(key, used + 1);
      }
      recent.push(now);
      windows.set(ws, recent);
    },
  };
}
