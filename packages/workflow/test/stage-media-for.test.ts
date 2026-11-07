import type { Job, MediaProvider, TenantContext } from "@studix/core";
import { createLogger } from "@studix/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createJobExecutor,
  type JobExecutorDeps,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
const job = {
  id: "job_1",
  organizationId: "org_1",
  workspaceId: "ws_1",
  kind: "test.media",
  status: "running",
  payload: {},
  progress: 0,
  attempts: 1,
  maxAttempts: 1,
  spentCents: 0,
  cancelRequested: false,
} as unknown as Job;

function fakeQueue() {
  const settled = () => Promise.resolve(true);
  return {
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
  } as unknown as WorkerJobQueue;
}

const provider = (id: string) => ({ id }) as unknown as MediaProvider;

async function mediaSeenBy(deps: Partial<JobExecutorDeps>): Promise<string | undefined> {
  let seen: string | undefined;
  const workflow: WorkflowDefinition = {
    kind: "test.media",
    stages: [
      {
        name: "media",
        inputSchema: z.unknown(),
        outputSchema: z.object({}),
        async run(s) {
          seen = s.services.media?.id;
          return { output: {} };
        },
      },
    ],
    result: () => ({ ok: true }),
  };
  await createJobExecutor({
    queue: fakeQueue(),
    workflows: [workflow],
    jobs: { listStages: async () => [] } as unknown as JobExecutorDeps["jobs"],
    approvals: {} as JobExecutorDeps["approvals"],
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: { record: async () => ({}), jobCostCents: async () => 0 } as unknown as JobExecutorDeps["ledger"],
    clock,
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: 10_000,
    ...deps,
  }).execute(job, "worker-1", new AbortController().signal);
  return seen;
}

describe("mediaFor", () => {
  it("hands stages the media provider of the job's workspace", async () => {
    const mediaFor = vi.fn(async (ctx: TenantContext) => provider(`ws:${ctx.workspaceId}`));
    expect(await mediaSeenBy({ services: { media: provider("server") }, mediaFor })).toBe("ws:ws_1");
    expect(mediaFor).toHaveBeenCalledOnce();
  });

  it("keeps the wired provider when the workspace has none", async () => {
    const seen = await mediaSeenBy({
      services: { media: provider("server") },
      mediaFor: async () => undefined,
    });
    expect(seen).toBe("server");
  });
});
