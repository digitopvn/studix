import type { Job, TenantContext } from "@studix/core";
import { createLogger } from "@studix/shared";
import type { StoryboardReviewStatus } from "@studix/video-ir";
import { describe, expect, it, vi } from "vitest";
import {
  createJobExecutor,
  type JobExecutorDeps,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const clock = { now: () => new Date("2026-01-01T00:00:00Z") };

function makeJob(projectId?: string): Job {
  return {
    id: "job_1",
    organizationId: "org_1",
    workspaceId: "ws_1",
    projectId,
    kind: "test.i2v",
    status: "running",
    payload: {},
    progress: 0,
    attempts: 1,
    maxAttempts: 3,
    spentCents: 0,
    cancelRequested: false,
  } as unknown as Job;
}

function fakeQueue() {
  const settled = () => Promise.resolve(true);
  const queue = {
    leaseMs: 60_000,
    heartbeat: vi.fn(async () => ({ held: true, cancelRequested: false })),
    updateProgress: vi.fn(settled),
    writeStage: vi.fn(settled),
    recordUsage: vi.fn(settled),
    complete: vi.fn(settled),
    fail: vi.fn(settled),
    cancel: vi.fn(settled),
    retry: vi.fn(settled),
    release: vi.fn(settled),
    park: vi.fn(settled),
  };
  return queue as typeof queue & WorkerJobQueue;
}

/** One paid image-to-video stage that only a human-approved storyboard may start. */
function i2vWorkflow(runs: string[]): WorkflowDefinition {
  return {
    kind: "test.i2v",
    stages: [
      {
        name: "i2v",
        requiresApprovedStoryboard: true,
        async run() {
          runs.push("i2v");
          return {
            output: {},
            usage: [{ item: "gen", kind: "test.i2v", quantity: 1, unit: "call", costCents: 50 }],
          };
        },
      },
    ],
    result: () => ({ ok: true }),
  };
}

async function run(job: Job, storyboardStatus?: JobExecutorDeps["storyboardStatus"]) {
  const runs: string[] = [];
  const queue = fakeQueue();
  const executor = createJobExecutor({
    queue,
    workflows: [i2vWorkflow(runs)],
    jobs: { listStages: async () => [] } as unknown as JobExecutorDeps["jobs"],
    approvals: {} as JobExecutorDeps["approvals"],
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: { record: async () => ({}), jobCostCents: async () => 0 } as unknown as JobExecutorDeps["ledger"],
    clock,
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: 10_000,
    storyboardStatus,
  });
  await executor.execute(job, "worker-1", new AbortController().signal);
  return { runs, queue };
}

const failure = (queue: ReturnType<typeof fakeQueue>) =>
  (queue.fail.mock.calls[0] as unknown as [unknown, unknown, { code: string; retryable: boolean }])[2];

describe("storyboard approval gate", () => {
  it("runs an image-to-video stage once the storyboard is approved", async () => {
    const seen: string[] = [];
    const status = async (_ctx: TenantContext, projectId: string): Promise<StoryboardReviewStatus> => {
      seen.push(projectId);
      return "approved";
    };
    const { runs, queue } = await run(makeJob("prj_1"), status);
    expect(runs).toEqual(["i2v"]);
    expect(seen).toEqual(["prj_1"]);
    expect(queue.complete).toHaveBeenCalledOnce();
  });

  it.each<StoryboardReviewStatus | undefined>(["draft", "in_review", "changes_requested", undefined])(
    "fails without running or charging when the storyboard is %s",
    async (status) => {
      const { runs, queue } = await run(makeJob("prj_1"), async () => status);
      expect(runs).toEqual([]);
      expect(queue.recordUsage).not.toHaveBeenCalled();
      expect(queue.retry).not.toHaveBeenCalled();
      expect(failure(queue)).toMatchObject({ code: "APPROVAL_REQUIRED", retryable: false });
    },
  );

  it("fails closed when the runner cannot read storyboard status, or the job has no project", async () => {
    for (const job of [makeJob("prj_1"), makeJob(undefined)]) {
      const { runs, queue } = await run(job, job.projectId ? undefined : async () => "approved");
      expect(runs).toEqual([]);
      expect(failure(queue)).toMatchObject({ code: "APPROVAL_REQUIRED" });
    }
  });
});
