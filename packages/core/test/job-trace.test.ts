import { describe, expect, it } from "vitest";
import { agentTraceKey, type Job, readJobTrace, type Stage, toJobView } from "../src/index.ts";
import { testTenant } from "../src/testing/index.ts";

const now = new Date("2026-11-12T06:30:00Z");
const ctx = testTenant();
const job = {
  id: "job_1",
  organizationId: ctx.organizationId,
  workspaceId: ctx.workspaceId,
  status: "running",
  stage: "skill-agent.run",
  attempts: 1,
} as unknown as Job;

const stage = (name: string, attempt: number, extra: Partial<Stage> = {}): Stage =>
  ({ id: `stg_${name}_${attempt}`, jobId: job.id, name, attempt, status: "succeeded", ...extra }) as Stage;

const line = (seq: number, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, ts: new Date(now.getTime() - 60_000 + seq).toISOString(), type, ...extra });

function deps(stages: Stage[], objects: Record<string, string>) {
  return {
    jobs: {
      get: async (_c: unknown, id: string) => (id === job.id ? job : undefined),
      listStages: async () => stages,
    },
    traces: { read: async (_c: unknown, key: string) => objects[key] },
    clock: { now: () => now },
  };
}

describe("job trace", () => {
  const running = stage("skill-agent.run", 1, {
    status: "running",
    lastActivityAt: new Date(now.getTime() - 25 * 60_000),
  });
  const objects = {
    [agentTraceKey(job.id, "skill-agent.run", 1, 0)]: [
      line(0, "run", { skill: "skill-agent.run" }),
      line(1, "tool_start", { id: "a", name: "bash" }),
      line(2, "tool_end", { id: "a", name: "bash", ok: false, exitCode: 1, durationMs: 9_000 }),
      "{torn",
    ].join("\n"),
    [agentTraceKey(job.id, "skill-agent.run", 1, 1)]: line(0, "turn", { latencyMs: 3_000, inputTokens: 5 }),
  };

  it("summarizes each run of the latest attempt and marks a quiet running stage stalled", async () => {
    const view = await readJobTrace(deps([stage("brief", 1), running], objects), ctx, { jobId: job.id });
    if (view.view !== "summary") throw new Error("expected summary");
    const traced = view.stages.find((s) => s.name === "skill-agent.run");
    expect(traced).toMatchObject({ stalled: true });
    expect(traced?.runs.map((r) => [r.run, r.toolFailures, r.turns])).toEqual([
      [0, 1, 0],
      [1, 0, 1],
    ]);
    expect(view.stages.find((s) => s.name === "brief")?.runs).toEqual([]);
    expect(view.next[0]?.arguments).toMatchObject({ stage: "skill-agent.run", view: "full" });
  });

  it("pages the full view across runs with a cursor", async () => {
    const first = await readJobTrace(deps([running], objects), ctx, {
      jobId: job.id,
      view: "full",
      limit: 2,
    });
    if (first.view !== "full") throw new Error("expected full");
    expect(first.events.map((e) => [e.run, e.type])).toEqual([
      [0, "run"],
      [0, "tool_start"],
    ]);
    expect(first.total).toBe(4);
    const rest = await readJobTrace(deps([running], objects), ctx, {
      jobId: job.id,
      view: "full",
      cursor: first.nextCursor,
    });
    if (rest.view !== "full") throw new Error("expected full");
    expect(rest.events.map((e) => [e.run, e.type])).toEqual([
      [0, "tool_end"],
      [1, "turn"],
    ]);
    expect(rest.nextCursor).toBeUndefined();
  });

  it("refuses a job of another workspace as not found", async () => {
    await expect(readJobTrace(deps([], {}), ctx, { jobId: "job_other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("warns in get_job when a running stage went quiet", () => {
    const view = toJobView(job, [running], undefined, undefined, undefined, now);
    expect(view.stages[0]).toMatchObject({ stalled: true, lastActivityAt: running.lastActivityAt });
    expect(view.next[0]).toMatchObject({ tool: "studix_job_trace", arguments: { stage: "skill-agent.run" } });
    const fresh = toJobView(job, [{ ...running, lastActivityAt: now }], undefined, undefined, undefined, now);
    expect(fresh.stages[0]?.stalled).toBeUndefined();
    expect(fresh.next[0]?.tool).toBe("studix_get_job");
  });
});
