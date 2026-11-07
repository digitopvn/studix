import {
  type CompositionRunRequest,
  type CompositionRunResult,
  JOB_KINDS,
  CompositionRunRequest as Request,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { StageFailedAfterSpend } from "./stage-signals.ts";
import type { StageContext, StageUsage, WorkflowDefinition } from "./workflow-types.ts";

/** Runs one command over a composition in the skill sandbox and stores what it wrote; supplied by the worker. */
export interface CompositionRunner {
  /** Resolves whatever the exit code; rejects only when the run could not happen (sandbox, storage, limits). */
  run(stage: StageContext, request: CompositionRunRequest): Promise<CompositionRunResult>;
}

export interface CompositionRunWorkflowDeps {
  /** Unset when the worker has no skill sandbox; such jobs then fail UNAVAILABLE. */
  runner?: CompositionRunner;
  /** Compute price per started minute of sandbox time. */
  centsPerMinute: number;
}

const TAIL = 3000;

/**
 * `composition.run`: one stage, never retried (a failed command fails the same way again). A non-zero exit
 * or a failed output check fails the job with the log tail; the files it wrote are kept either way.
 */
export function createCompositionRunWorkflow(deps: CompositionRunWorkflowDeps): WorkflowDefinition {
  const requestOf = (s: StageContext) => Request.parse((s.job.payload as { request?: unknown }).request);
  return {
    kind: JOB_KINDS.compositionRun,
    result: (outputs) => outputs.run ?? {},
    stages: [
      {
        name: "run",
        retry: "never",
        estimateCostCents: (s) => Math.ceil(requestOf(s).timeoutSeconds / 60) * deps.centsPerMinute,
        async run(s) {
          const request = requestOf(s);
          if (!deps.runner) {
            throw new StudixError("UNAVAILABLE", "This worker has no skill sandbox", {
              retryable: false,
              suggestedAction: "Set STUDIX_SANDBOX=docker on the worker.",
            });
          }
          const result = await deps.runner.run(s, request);
          const minutes = Math.max(1, Math.ceil(result.durationMs / 60_000));
          const usage: StageUsage[] = [
            {
              item: "run",
              kind: "compute",
              quantity: Math.round(result.durationMs) / 1000,
              unit: "second",
              costCents: minutes * deps.centsPerMinute,
              metadata: { exitCode: result.exitCode, changed: result.changed.length },
            },
          ];
          const failure =
            result.exitCode !== 0
              ? `The command exited with code ${result.exitCode}`
              : result.check && !result.check.passed
                ? `${result.check.path} fails its output check: ${result.check.problems.join("; ")}`
                : undefined;
          if (failure) {
            throw new StageFailedAfterSpend(
              new StudixError("VALIDATION", failure, {
                retryable: false,
                details: {
                  exitCode: result.exitCode,
                  logTail: result.log.slice(-TAIL),
                  changed: result.changed.map((f) => f.path),
                  ...(result.check ? { check: result.check } : {}),
                },
                suggestedAction: "Fix the files or command from the log tail and run again.",
              }),
              usage,
            );
          }
          return {
            output: { ...result, log: result.log.slice(-TAIL) },
            usage,
          };
        },
      },
    ],
  };
}
