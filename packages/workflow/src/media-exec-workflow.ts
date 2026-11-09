import {
  JOB_KINDS,
  MEDIA_EXEC_LIMITS,
  type MediaExecRequest,
  type MediaExecResult,
  parseMediaExecRequest,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { killedCommandError, reachedTimeout } from "./killed-command-error.ts";
import { StageFailedAfterSpend } from "./stage-signals.ts";
import type { StageContext, StageUsage, WorkflowDefinition } from "./workflow-types.ts";

/** Runs one media exec request in an isolated sandbox; supplied by the worker. */
export interface MediaExecRunner {
  /**
   * Stages the inputs, runs the tool and stores the declared outputs as workspace assets. Resolves with the
   * result whatever the exit code; rejects only when the run could not happen (sandbox, input, limits).
   */
  run(stage: StageContext, request: MediaExecRequest): Promise<MediaExecResult>;
}

export interface MediaExecWorkflowDeps {
  /** Unset when the worker has no sandbox; media exec jobs then fail UNAVAILABLE. */
  runner?: MediaExecRunner;
  /** Compute price per started minute of sandbox time. */
  centsPerMinute: number;
}

const STDERR_TAIL = 2000;
/** The exit code the runner reports for a tool it killed (the `timeout(1)` convention). */
const KILLED_EXIT_CODE = 124;

/** `media.exec`: one stage, never retried automatically (a failed command fails the same way again). */
export function createMediaExecWorkflow(deps: MediaExecWorkflowDeps): WorkflowDefinition {
  const requestOf = (s: StageContext) =>
    parseMediaExecRequest((s.job.payload as { request?: unknown }).request);
  return {
    kind: JOB_KINDS.mediaExec,
    result: (outputs) => outputs.exec ?? {},
    stages: [
      {
        name: "exec",
        retry: "never",
        // The budget must cover the whole timeout before the sandbox starts.
        estimateCostCents: (s) => Math.ceil(requestOf(s).timeoutSeconds / 60) * deps.centsPerMinute,
        async run(s) {
          const request = requestOf(s);
          if (!deps.runner) {
            throw new StudixError("UNAVAILABLE", "This worker has no media sandbox", {
              retryable: false,
              suggestedAction: "Set STUDIX_SANDBOX=docker on the worker with an image that has ffmpeg.",
            });
          }
          const result = await deps.runner.run(s, request);
          const minutes = Math.max(1, Math.ceil(result.durationMs / 60_000));
          const usage: StageUsage[] = [
            {
              item: "exec",
              kind: "compute",
              quantity: Math.round(result.durationMs) / 1000,
              unit: "second",
              costCents: minutes * deps.centsPerMinute,
              metadata: { tool: request.tool, exitCode: result.exitCode },
            },
          ];
          if (
            result.exitCode === KILLED_EXIT_CODE &&
            reachedTimeout(result.durationMs, request.timeoutSeconds)
          ) {
            throw new StageFailedAfterSpend(
              killedCommandError({
                subject: request.tool,
                timeoutSeconds: request.timeoutSeconds,
                maxTimeoutSeconds: MEDIA_EXEC_LIMITS.maxTimeoutSeconds,
                durationMs: result.durationMs,
                details: { exitCode: null, stderrTail: result.stderr.slice(-STDERR_TAIL).trim() },
              }),
              usage,
            );
          }
          if (result.exitCode !== 0) {
            const tail = result.stderr.slice(-STDERR_TAIL).trim();
            throw new StageFailedAfterSpend(
              new StudixError("VALIDATION", `${request.tool} exited with code ${result.exitCode}: ${tail}`, {
                retryable: false,
                details: {
                  exitCode: result.exitCode,
                  stderrTail: tail,
                  stdout: result.stdout.slice(0, STDERR_TAIL),
                },
                suggestedAction: "Fix the arguments from the stderr tail and start a new call.",
              }),
              usage,
            );
          }
          return { output: { ...result }, usage };
        },
      },
    ],
  };
}
