import { createManualClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  compareJobs,
  decodeJobCursor,
  encodeJobCursor,
  JOB_SORT_FIELDS,
  type Job,
  type JobListQuery,
  type JobRepository,
  jobAgent,
  jobMatches,
  type TenantContext,
} from "../src/index.ts";
import { createInMemoryJobStore } from "../src/testing/index.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

async function pageAll(repo: JobRepository, query: JobListQuery): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.list(ctx, { ...query, limit: 2, cursor });
    ids.push(...page.items.map((j) => j.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

const agent = (runtime: string, modelId?: string, reasoningEffort?: string) => ({
  agent: { runtime, connectionId: "pc_1", provider: "openrouter", modelId, reasoningEffort },
});
/** One payload per seeded job: each agent runtime kind, the legacy planner and a job with no agent. */
const payloads: Array<Record<string, unknown>> = [
  agent("pi", "deepseek-v4.1-flash", "high"),
  { planner: { runtime: "claude", providerConnectionId: "pc_2" } },
  agent("codex", "gpt-5.5-codex"),
  {},
  { agentMode: "host", ...agent("claude", "claude-opus-5-5") },
];

async function seed() {
  const clock = createManualClock(Date.UTC(2026, 10, 1));
  const { jobs, queue } = createInMemoryJobStore(clock);
  const specs = [
    { kind: "video.create", status: "running", stage: "storyboard", progress: 0.5, spentCents: 120 },
    { kind: "video.render", status: "succeeded", stage: undefined, progress: 1, spentCents: 900 },
    { kind: "video.create", status: "failed", stage: "voice", progress: 0.25, spentCents: 120 },
    { kind: "video.create", status: "queued", stage: undefined, progress: 0, spentCents: 0 },
    { kind: "video.render", status: "running", stage: "voice", progress: 0.5, spentCents: 40 },
  ] as const;
  const all: Job[] = [];
  for (const [i, spec] of specs.entries()) {
    // Two jobs share each timestamp, so every date sort has ties broken by id.
    if (i % 2 === 0) clock.advance(60_000);
    const { job } = await queue.enqueue(ctx, {
      kind: spec.kind,
      payload: payloads[i]!,
      projectId: i < 3 ? `prj_alpha${i}` : undefined,
      createdBy: { type: "user", id: "usr_1" },
    });
    all.push(
      await jobs.update(ctx, job.id, {
        status: spec.status,
        progress: spec.progress,
        spentCents: spec.spentCents,
        ...(spec.stage ? { stage: spec.stage } : {}),
      }),
    );
  }
  return { jobs, all };
}

describe("job list query", () => {
  it("defaults to newest created first", async () => {
    const { jobs, all } = await seed();
    const expected = [...all].sort(compareJobs("createdAt", "desc")).map((j) => j.id);
    expect(await pageAll(jobs, {})).toEqual(expected);
    expect(expected[0]).toBe(all[4]!.id);
  });

  it("pages every sort in both orders without skipping or repeating a row", async () => {
    const { jobs, all } = await seed();
    for (const sort of JOB_SORT_FIELDS) {
      for (const order of ["asc", "desc"] as const) {
        const expected = [...all].sort(compareJobs(sort, order)).map((j) => j.id);
        expect(await pageAll(jobs, { sort, order }), `${sort} ${order}`).toEqual(expected);
      }
    }
  });

  it("applies every filter, combined with sort and cursor", async () => {
    const { jobs, all } = await seed();
    const t1 = all[2]!.createdAt;
    const cases: JobListQuery[] = [
      { status: ["running", "failed"] },
      { kind: ["video.render"] },
      { stage: ["voice"] },
      { agent: ["pi", "none"] },
      { agent: ["planner", "host"] },
      { modelContains: "DEEPSEEK" },
      { idContains: all[1]!.id.slice(-6).toUpperCase() },
      { projectContains: "ALPHA" },
      { createdFrom: t1 },
      { createdTo: t1 },
      { updatedFrom: t1, updatedTo: t1 },
      { progressMin: 0.25, progressMax: 0.5 },
      { spentMin: 100, spentMax: 200, sort: "progress", order: "asc" },
    ];
    for (const query of cases) {
      const expected = all
        .filter((j) => jobMatches(j, query))
        .sort(compareJobs(query.sort ?? "createdAt", query.order ?? "desc"))
        .map((j) => j.id);
      expect(expected.length, JSON.stringify(query)).toBeGreaterThan(0);
      expect(expected.length, JSON.stringify(query)).toBeLessThan(all.length);
      expect(await pageAll(jobs, query), JSON.stringify(query)).toEqual(expected);
    }
  });

  it("reads the agent runtime, model and effort from the payload", async () => {
    const { all } = await seed();
    expect(all.map((j) => jobAgent(j))).toEqual([
      { runtime: "pi", provider: "openrouter", model: "deepseek-v4.1-flash", reasoningEffort: "high" },
      { runtime: "planner", provider: "anthropic" },
      { runtime: "codex", provider: "openrouter", model: "gpt-5.5-codex" },
      { runtime: "none" },
      { runtime: "host" },
    ]);
  });

  it("keeps tenants apart", async () => {
    const { jobs } = await seed();
    const other = { ...ctx, workspaceId: "ws_2" };
    expect((await jobs.list(other, {})).items).toEqual([]);
  });

  it("rejects malformed cursors and cursors from another sort", () => {
    expect(decodeJobCursor(encodeJobCursor(5, "job_1"), "progress")).toEqual({ value: 5, id: "job_1" });
    expect(() => decodeJobCursor(encodeJobCursor("x", "job_1"), "progress")).toThrow(/cursor/);
    expect(() => decodeJobCursor(encodeJobCursor(5, "job_1"), "kind")).toThrow(/cursor/);
    expect(() => decodeJobCursor("not-json", "kind")).toThrow(/cursor/);
    expect(() => decodeJobCursor(encodeJobCursor("x", "bad id!"), "kind")).toThrow(/cursor/);
  });
});
