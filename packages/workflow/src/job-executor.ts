import type { Job, TenantContext } from "@studix/core";
import { StudixError, toStudixError } from "@studix/shared";
import { DEFAULT_RETRY_BACKOFF, type RetryBackoffOptions, retryDelayMs } from "./retry-backoff.ts";
import { runStages, StageFailure, type StageRunnerDeps } from "./stage-runner.ts";
import type { WorkerJobQueue } from "./worker-job-queue.ts";
import type { WorkflowDefinition } from "./workflow-types.ts";

export type JobOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "retrying"
  | "waiting_approval"
  /** Given back to the queue on shutdown without consuming the attempt. */
  | "released"
  /** Another worker owns the job now; nothing was written. */
  | "lease_lost";

export interface JobExecutorDeps extends StageRunnerDeps {
  queue: WorkerJobQueue;
  workflows: readonly WorkflowDefinition[];
  /** How often the lease is renewed and cancellation is polled; must be well below the lease. */
  heartbeatIntervalMs: number;
  retryBackoff?: RetryBackoffOptions;
}

export interface JobExecutor {
  /**
   * Run one claimed job to an outcome. `shutdown` aborts the attempt and releases the lease.
   * `draining` marks that the process is stopping: an attempt that fails after it fired is released
   * too, because the failure is usually collateral (e.g. Puppeteer closes Chrome on SIGTERM).
   */
  execute(job: Job, workerId: string, shutdown: AbortSignal, draining?: AbortSignal): Promise<JobOutcome>;
}

/** setTimeout overflows above 2^31-1 ms; longer deadlines are re-checked at claim time. */
const MAX_TIMER_MS = 2_147_000_000;

type StopReason = "cancel" | "timeout" | "shutdown" | "lease_lost";

const STOP_ERRORS: Record<StopReason, () => StudixError> = {
  cancel: () => new StudixError("CANCELLED", "Job was cancelled", { retryable: false }),
  timeout: () =>
    new StudixError("TIMEOUT", "Job deadline reached", {
      retryable: false,
      suggestedAction: "Submit the job again with a later deadline or a shorter video.",
    }),
  shutdown: () =>
    new StudixError("UNAVAILABLE", "Worker is shutting down", { details: { reason: "shutdown" } }),
  lease_lost: () => new StudixError("CONFLICT", "Job lease was lost to another worker", { retryable: false }),
};

/** Executes claimed jobs: lease heartbeat, cancel/deadline/shutdown observation, stages, retries. */
export function createJobExecutor(deps: JobExecutorDeps): JobExecutor {
  if (!Number.isInteger(deps.heartbeatIntervalMs) || deps.heartbeatIntervalMs < 10) {
    throw new RangeError("heartbeatIntervalMs must be an integer >= 10");
  }
  const registry = new Map(deps.workflows.map((w) => [w.kind, w]));
  const backoff = deps.retryBackoff ?? DEFAULT_RETRY_BACKOFF;
  const { queue, clock, logger } = deps;

  return {
    async execute(job, workerId, shutdown, draining) {
      const log = logger.child({ jobId: job.id, kind: job.kind, attempt: job.attempts, workerId });
      const ctx: TenantContext = {
        organizationId: job.organizationId,
        workspaceId: job.workspaceId,
        actor: { type: "system", id: workerId },
      };
      const settle = async (written: Promise<boolean>, outcome: JobOutcome): Promise<JobOutcome> => {
        if (await written) {
          log.info("job attempt finished", { outcome });
          return outcome;
        }
        log.warn("job lease lost before the outcome could be written", { outcome });
        return "lease_lost";
      };

      const workflow = registry.get(job.kind);
      if (!workflow) {
        const error = new StudixError("VALIDATION", `No workflow is registered for job kind ${job.kind}`, {
          retryable: false,
        });
        return settle(queue.fail(job, workerId, error.toJSON()), "failed");
      }
      if (job.cancelRequested)
        return settle(queue.cancel(job, workerId, STOP_ERRORS.cancel().toJSON()), "cancelled");
      if (job.deadlineAt && job.deadlineAt <= clock.now()) {
        return settle(queue.fail(job, workerId, STOP_ERRORS.timeout().toJSON()), "failed");
      }

      const controller = new AbortController();
      let stop: StopReason | undefined;
      const abort = (reason: StopReason) => {
        if (stop) return;
        stop = reason;
        log.info("aborting job attempt", { reason });
        controller.abort(STOP_ERRORS[reason]());
      };
      const onShutdown = () => abort("shutdown");
      if (shutdown.aborted) onShutdown();
      shutdown.addEventListener("abort", onShutdown, { once: true });

      // If heartbeats keep failing (database unreachable, hung query), stop before the lease can lapse:
      // past that point another worker may claim the job and both would run it.
      let leaseExpiresAt = job.leaseExpiresAt?.getTime();
      const leaseAtRisk = () =>
        leaseExpiresAt !== undefined && clock.now().getTime() >= leaseExpiresAt - deps.heartbeatIntervalMs;
      let beating = false;
      const heartbeat = setInterval(() => {
        if (stop) return;
        if (leaseAtRisk()) {
          log.warn("lease could not be renewed in time, abandoning the attempt");
          abort("lease_lost");
          return;
        }
        if (beating) return;
        beating = true;
        queue
          .heartbeat(job, workerId)
          .then((hb) => {
            if (!hb.held) abort("lease_lost");
            else if (hb.cancelRequested) abort("cancel");
            if (hb.leaseExpiresAt) leaseExpiresAt = hb.leaseExpiresAt.getTime();
          })
          .catch((err) => log.warn("heartbeat failed", { error: String(err) }))
          .finally(() => {
            beating = false;
          });
      }, deps.heartbeatIntervalMs);
      const deadline = job.deadlineAt
        ? setTimeout(
            () => abort("timeout"),
            Math.min(MAX_TIMER_MS, job.deadlineAt.getTime() - clock.now().getTime()),
          )
        : undefined;

      try {
        const outcome = await runStages(deps, ctx, job, workflow, controller.signal);
        if (outcome.status === "waiting_approval") {
          log.info("job waits for approval", { approvalId: outcome.approval.id, stage: outcome.stage });
          return await settle(queue.park(job, workerId), "waiting_approval");
        }
        return await settle(queue.complete(job, workerId, outcome.result), "succeeded");
      } catch (err) {
        if (stop === "lease_lost") return "lease_lost";
        if (stop === "shutdown" || (stop === undefined && draining?.aborted)) {
          if (stop === undefined)
            log.warn("job attempt failed while draining, releasing", { error: String(err) });
          return await settle(queue.release(job, workerId), "released");
        }
        if (stop === "cancel")
          return await settle(queue.cancel(job, workerId, STOP_ERRORS.cancel().toJSON()), "cancelled");
        if (stop === "timeout")
          return await settle(queue.fail(job, workerId, STOP_ERRORS.timeout().toJSON()), "failed");

        const error = err instanceof StageFailure ? err.error : toStudixError(err);
        // A fenced stage/spend write found another worker owning the job: nothing of ours may be written.
        if (error.code === "CONFLICT" && error.details?.reason === "lease_lost") {
          log.warn("job lease lost during a stage write");
          return "lease_lost";
        }
        const retryAllowed = !(err instanceof StageFailure && err.stage.retry === "never");
        if (error.retryable && retryAllowed && job.attempts < job.maxAttempts) {
          const runAfter = new Date(clock.now().getTime() + retryDelayMs(job.attempts, backoff));
          log.warn("job attempt failed, retrying", { code: error.code, message: error.message, runAfter });
          return await settle(queue.retry(job, workerId, error.toJSON(), runAfter), "retrying");
        }
        log.error("job failed", { code: error.code, message: error.message });
        return await settle(queue.fail(job, workerId, error.toJSON()), "failed");
      } finally {
        clearInterval(heartbeat);
        if (deadline) clearTimeout(deadline);
        shutdown.removeEventListener("abort", onShutdown);
      }
    },
  };
}
