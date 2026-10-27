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
  execute(
    job: Job,
    workerId: string,
    shutdown: AbortSignal,
    draining?: AbortSignal,
    /** When the claim was sent, on the worker clock: the lease starts no earlier. Defaults to now. */
    claimSentAt?: Date,
  ): Promise<JobOutcome>;
}

/** setTimeout overflows above 2^31-1 ms; longer deadlines are re-checked at claim time. */
const MAX_TIMER_MS = 2_147_000_000;
/** Stop this long before the lease lapses when it cannot be renewed (capped at one heartbeat interval). */
const LEASE_SAFETY_MARGIN_MS = 5_000;
/** Delay before retrying a failed heartbeat (capped at a fifth of the heartbeat interval). */
const HEARTBEAT_RETRY_MS = 1_000;

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
  const safetyMarginMs = Math.min(deps.heartbeatIntervalMs, LEASE_SAFETY_MARGIN_MS);
  const { leaseMs } = deps.queue;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0)
    throw new RangeError("queue.leaseMs must be a positive integer");
  if (deps.heartbeatIntervalMs >= leaseMs - safetyMarginMs) {
    throw new RangeError(
      `heartbeatIntervalMs (${deps.heartbeatIntervalMs}) must be shorter than the lease (${leaseMs}) minus the safety margin (${safetyMarginMs})`,
    );
  }
  const registry = new Map(deps.workflows.map((w) => [w.kind, w]));
  const backoff = deps.retryBackoff ?? DEFAULT_RETRY_BACKOFF;
  const { queue, clock, logger } = deps;

  return {
    async execute(job, workerId, shutdown, draining, claimSentAt) {
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

      // Renew the lease every interval; after a failed beat retry sooner, so one database blip costs
      // nothing. A separate watchdog stops the attempt shortly before the lease would lapse (all beats
      // failing or hung): past that point another worker may claim the job and both would run it.
      // The database applies a renewal no earlier than the moment it was sent, so the lease is valid
      // until at least (send time + leaseMs). Both ends of that span are read from this worker's clock,
      // which keeps the watchdog independent of the skew between worker and database clocks.
      let leaseValidUntil = (claimSentAt ?? clock.now()).getTime() + leaseMs;
      const retryMs = Math.min(Math.ceil(deps.heartbeatIntervalMs / 5), HEARTBEAT_RETRY_MS);
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      // Set once the attempt settles: a beat still in flight then must not schedule more timers.
      let settled = false;
      const armWatchdog = () => {
        clearTimeout(watchdog);
        if (settled) return;
        const ms = leaseValidUntil - safetyMarginMs - clock.now().getTime();
        watchdog = setTimeout(
          () => {
            log.warn("lease could not be renewed in time, abandoning the attempt");
            abort("lease_lost");
          },
          Math.max(0, Math.min(MAX_TIMER_MS, ms)),
        );
      };
      let beatTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleBeat = (ms: number) => {
        if (!stop && !settled) beatTimer = setTimeout(beat, ms);
      };
      const beat = () => {
        if (stop || settled) return;
        // Armed from the first beat on: a beat that hangs or keeps failing must not outlive the lease.
        if (watchdog === undefined) armWatchdog();
        const sentAt = clock.now().getTime();
        queue
          .heartbeat(job, workerId)
          .then((hb) => {
            if (settled) return;
            if (!hb.held) return abort("lease_lost");
            if (hb.cancelRequested) return abort("cancel");
            leaseValidUntil = sentAt + leaseMs;
            armWatchdog();
            scheduleBeat(deps.heartbeatIntervalMs);
          })
          .catch((err) => {
            log.warn("heartbeat failed, retrying", { error: String(err) });
            scheduleBeat(retryMs);
          });
      };
      scheduleBeat(deps.heartbeatIntervalMs);
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
        const retryAllowed = !(err instanceof StageFailure && err.stage.retry === "never");
        if (error.retryable && retryAllowed && job.attempts < job.maxAttempts) {
          const runAfter = new Date(clock.now().getTime() + retryDelayMs(job.attempts, backoff));
          log.warn("job attempt failed, retrying", { code: error.code, message: error.message, runAfter });
          return await settle(queue.retry(job, workerId, error.toJSON(), runAfter), "retrying");
        }
        log.error("job failed", { code: error.code, message: error.message });
        return await settle(queue.fail(job, workerId, error.toJSON()), "failed");
      } finally {
        settled = true;
        clearTimeout(beatTimer);
        clearTimeout(watchdog);
        if (deadline) clearTimeout(deadline);
        shutdown.removeEventListener("abort", onShutdown);
      }
    },
  };
}
