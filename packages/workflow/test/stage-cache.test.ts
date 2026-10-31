import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "@studix/core";
import { createInMemoryStageCache } from "@studix/core/testing";
import { createLogger } from "@studix/shared";
import {
  applyPatch,
  type DependencyNode,
  nodeDigests,
  type VideoIR,
  VideoIR as VideoIRSchema,
  videoIrNodes,
} from "@studix/video-ir";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createJobExecutor,
  type JobExecutorDeps,
  type StageDefinition,
  stageCacheKey,
  type WorkerJobQueue,
  type WorkflowDefinition,
} from "../src/index.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "video-ir", "fixtures", "brand-intro-9x16.json");
const loadIr = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as VideoIR;
const clock = { now: () => new Date("2026-01-01T00:00:00Z") };

function makeJob(id: string, ir: VideoIR): Job {
  return {
    id,
    organizationId: "org_1",
    workspaceId: "ws_1",
    kind: "test.per-node",
    status: "running",
    payload: { ir },
    progress: 0,
    attempts: 1,
    maxAttempts: 1,
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

const IrInput = z.object({ payload: z.object({ ir: VideoIRSchema }) });

/**
 * One paid stage per shot, scene and the final document, each keyed by its node's Merkle digest: the
 * shape of a per-shot generation workflow where a node's key changes exactly when it or a dependency does.
 */
function perNodeWorkflow(runs: string[]): WorkflowDefinition {
  const nodes: DependencyNode[] = videoIrNodes(loadIr());
  const keys = nodes.map((n) => n.key).filter((k) => /^(shot|scene):|^document$/.test(k));
  const stages = keys.map(
    (key): StageDefinition => ({
      name: key,
      inputSchema: IrInput,
      outputSchema: z.object({ digest: z.string() }),
      cacheKey: (s) => {
        const { ir } = (s.input as z.infer<typeof IrInput>).payload;
        return stageCacheKey(key, 1, nodeDigests(videoIrNodes(ir)).get(key));
      },
      async run(s) {
        runs.push(key);
        const { ir } = (s.input as z.infer<typeof IrInput>).payload;
        return {
          output: { digest: nodeDigests(videoIrNodes(ir)).get(key)! },
          usage: [{ item: "gen", kind: "test.generation", quantity: 1, unit: "call", costCents: 5 }],
        };
      },
    }),
  );
  return { kind: "test.per-node", stages, result: () => ({ ok: true }) };
}

function makeExecutor(
  queue: WorkerJobQueue,
  workflow: WorkflowDefinition,
  overrides: Partial<JobExecutorDeps>,
) {
  return createJobExecutor({
    queue,
    workflows: [workflow],
    jobs: { listStages: async () => [] } as unknown as JobExecutorDeps["jobs"],
    approvals: {} as JobExecutorDeps["approvals"],
    approvalPolicy: {} as JobExecutorDeps["approvalPolicy"],
    approvalTtlMs: 1,
    billing: { authorizeSpend: async () => ({ allowed: true }) } as unknown as JobExecutorDeps["billing"],
    ledger: {
      record: async () => ({}),
      jobCostCents: async () => 0,
    } as unknown as JobExecutorDeps["ledger"],
    clock,
    logger: createLogger({}, { level: "error", write: () => {} }),
    heartbeatIntervalMs: 10_000,
    ...overrides,
  });
}

async function run(job: Job, workflow: WorkflowDefinition, deps: Partial<JobExecutorDeps>) {
  const queue = fakeQueue();
  await makeExecutor(queue, workflow, deps).execute(job, "worker-1", new AbortController().signal);
  return queue;
}

describe("stage cache", () => {
  it("patching one shot re-runs and re-charges only that shot and its dependents", async () => {
    const stageCache = createInMemoryStageCache(clock);
    const runs: string[] = [];
    const workflow = perNodeWorkflow(runs);
    const before = loadIr();

    const first = await run(makeJob("job_1", before), workflow, { stageCache });
    expect(first.complete).toHaveBeenCalledOnce();
    expect(runs).toHaveLength(workflow.stages.length);
    expect(first.recordUsage).toHaveBeenCalledTimes(workflow.stages.length);

    runs.length = 0;
    const after = applyPatch(before, {
      ops: [{ op: "replace", path: "/scenes/2/shots/0/text", value: "Giao hàng trong 2 giờ" }],
    });
    const second = await run(makeJob("job_2", after), workflow, { stageCache });
    expect(second.complete).toHaveBeenCalledOnce();
    expect(runs.sort()).toEqual(["document", "scene:feature", "shot:feature-1"]);
    expect(second.recordUsage).toHaveBeenCalledTimes(3);
    // Reused stages are still checkpointed for the new job, with the cached output.
    const written = (second.writeStage.mock.calls as unknown as [unknown, unknown, { name: string }][]).map(
      ([, , stage]) => stage.name,
    );
    expect(written.filter((n) => n === "shot:hook-title")).toHaveLength(1);
  });

  it("an identical job runs nothing and pays nothing", async () => {
    const stageCache = createInMemoryStageCache(clock);
    const runs: string[] = [];
    const workflow = perNodeWorkflow(runs);
    await run(makeJob("job_1", loadIr()), workflow, { stageCache });
    runs.length = 0;
    const again = await run(makeJob("job_2", loadIr()), workflow, { stageCache });
    expect(runs).toEqual([]);
    expect(again.recordUsage).not.toHaveBeenCalled();
    expect(again.complete).toHaveBeenCalledOnce();
  });

  it("without a stage cache every stage runs", async () => {
    const runs: string[] = [];
    const workflow = perNodeWorkflow(runs);
    await run(makeJob("job_1", loadIr()), workflow, {});
    await run(makeJob("job_2", loadIr()), workflow, {});
    expect(runs).toHaveLength(2 * workflow.stages.length);
  });

  it("a cache entry that no longer matches the output schema is ignored", async () => {
    const stageCache = createInMemoryStageCache(clock);
    const runs: string[] = [];
    const workflow = perNodeWorkflow(runs);
    const ir = loadIr();
    const key = stageCacheKey("document", 1, nodeDigests(videoIrNodes(ir)).get("document"));
    await stageCache.put({ organizationId: "org_1", workspaceId: "ws_1" } as never, {
      stage: "document",
      cacheKey: key,
      output: { stale: true },
    });
    await run(makeJob("job_1", ir), workflow, { stageCache });
    expect(runs).toContain("document");
  });

  it("an input that fails the stage input schema fails the job without running anything", async () => {
    const runs: string[] = [];
    const queue = await run(
      makeJob("job_1", { nope: true } as unknown as VideoIR),
      perNodeWorkflow(runs),
      {},
    );
    expect(runs).toEqual([]);
    expect(queue.fail).toHaveBeenCalledOnce();
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it("an output that fails the stage output schema fails the job", async () => {
    const workflow: WorkflowDefinition = {
      kind: "test.per-node",
      stages: [
        { name: "bad", outputSchema: z.object({ ok: z.literal(true) }), run: async () => ({ output: {} }) },
      ],
      result: () => ({}),
    };
    const queue = await run(makeJob("job_1", loadIr()), workflow, {});
    expect(queue.fail).toHaveBeenCalledOnce();
  });
});
