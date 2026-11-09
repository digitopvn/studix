import type { CompositionRunResult, MediaExecResult } from "@studix/core";
import type { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  createCompositionRunWorkflow,
  createMediaExecWorkflow,
  type StageContext,
  StageFailedAfterSpend,
} from "../src/index.ts";

const stageOf = (request: Record<string, unknown>) =>
  ({
    job: { id: "job_1", payload: { request } },
    signal: new AbortController().signal,
  }) as never as StageContext;

async function failure(run: Promise<unknown>): Promise<{ error: StudixError; spent: number }> {
  const err = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StageFailedAfterSpend);
  const { error, usage } = err as StageFailedAfterSpend;
  return { error: error as StudixError, spent: usage.reduce((sum, u) => sum + u.costCents, 0) };
}

function compositionRun(result: Partial<CompositionRunResult>) {
  const workflow = createCompositionRunWorkflow({
    centsPerMinute: 2,
    runner: {
      run: async () => ({ log: "frame 900/1800", changed: [], exitCode: null, durationMs: 0, ...result }),
    },
  });
  const stage = stageOf({
    compositionId: "cmp_abcdef",
    command: "npx hyperframes render",
    timeoutSeconds: 480,
  });
  return workflow.stages[0]?.run(stage) as Promise<unknown>;
}

describe("killed sandbox commands", () => {
  it("reports a composition run killed at its timeout as TIMEOUT, still billed", async () => {
    const { error, spent } = await failure(compositionRun({ durationMs: 495_000 }));
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toBe("The command was killed after 480s timeout");
    expect(error.retryable).toBe(false);
    expect(error.suggestedAction).toContain("Raise timeoutSeconds (max 3600)");
    expect(error.details).toMatchObject({ exitCode: null, logTail: "frame 900/1800", reason: "timeout" });
    expect(spent).toBe(18);
  });

  it("reports a composition run killed before its timeout as UNAVAILABLE", async () => {
    const { error } = await failure(compositionRun({ durationMs: 30_000 }));
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });

  it("keeps a non-zero exit a VALIDATION failure", async () => {
    const { error } = await failure(compositionRun({ exitCode: 1, durationMs: 1_000 }));
    expect(error.code).toBe("VALIDATION");
  });

  it("reports a media exec killed at its timeout as TIMEOUT", async () => {
    const result: MediaExecResult = {
      tool: "ffmpeg",
      exitCode: 124,
      durationMs: 60_500,
      stdout: "",
      stderr: "\n[studix] killed after 60s timeout",
      stdoutTruncated: false,
      stderrTruncated: false,
      outputs: [],
    };
    const workflow = createMediaExecWorkflow({ centsPerMinute: 1, runner: { run: async () => result } });
    const stage = stageOf({
      tool: "ffmpeg",
      args: ["-i", "{in:v.mp4}", "{out:o.mp4}"],
      inputs: { "v.mp4": { base64: "AA==" } },
      outputs: [{ name: "o.mp4" }],
      timeoutSeconds: 60,
    });
    const { error } = await failure(workflow.stages[0]?.run(stage) as Promise<unknown>);
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toBe("ffmpeg was killed after 60s timeout");
  });
});
