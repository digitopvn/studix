import {
  compareJobs,
  JOB_SORT_FIELDS,
  type Job,
  type JobListQuery,
  jobMatches,
  type TenantContext,
} from "@studix/core";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

async function pageAll(ctx: TenantContext, query: JobListQuery): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await db.current.repos.jobs.list(ctx, { ...query, limit: 2, cursor });
    ids.push(...page.items.map((j) => j.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

const specs = [
  { kind: "video.create", status: "running", stage: "storyboard", progress: 1 / 3, spentCents: 120 },
  { kind: "video.render", status: "succeeded", stage: undefined, progress: 1, spentCents: 900 },
  { kind: "video.create", status: "failed", stage: "voice", progress: 0.25, spentCents: 120 },
  { kind: "video.create", status: "queued", stage: undefined, progress: 0, spentCents: 0 },
  { kind: "video_render", status: "running", stage: "voice", progress: 1 / 3, spentCents: 40 },
] as const;

async function seed(ctx: TenantContext): Promise<Job[]> {
  const { queue, jobs } = db.current.repos;
  const all: Job[] = [];
  for (const spec of specs) {
    const { job } = await queue.enqueue(ctx, {
      kind: spec.kind,
      payload: {},
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
  // Read back so dates and reals carry exactly what the database stores.
  return Promise.all(all.map(async (j) => (await jobs.get(ctx, j.id))!));
}

describe("Postgres job list query", () => {
  it("sorts by every allowlisted column with stable keyset pages", async () => {
    const ctx = await tenant("job-list-sort");
    const all = await seed(ctx);
    expect(await pageAll(ctx, {})).toEqual([...all].sort(compareJobs("createdAt", "desc")).map((j) => j.id));
    for (const sort of JOB_SORT_FIELDS) {
      for (const order of ["asc", "desc"] as const) {
        const expected = [...all].sort(compareJobs(sort, order)).map((j) => j.id);
        expect(await pageAll(ctx, { sort, order }), `${sort} ${order}`).toEqual(expected);
      }
    }
  });

  it("filters on every column, treats LIKE wildcards literally and stays in the tenant", async () => {
    const ctx = await tenant("job-list-filter");
    const other = await tenant("job-list-other");
    const all = await seed(ctx);
    await seed(other);
    const first = all[0]!;
    const cases: JobListQuery[] = [
      { status: ["running", "failed"] },
      { kind: ["video.render", "video_render"] },
      { stage: ["voice"] },
      { idContains: first.id.slice(-8).toUpperCase() },
      { createdFrom: all[2]!.createdAt },
      { createdTo: all[2]!.createdAt },
      { updatedFrom: all[1]!.updatedAt, updatedTo: all[3]!.updatedAt },
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
      expect(await pageAll(ctx, query), JSON.stringify(query)).toEqual(expected);
    }
    // `_` and `%` match themselves, not any character.
    expect(await pageAll(ctx, { idContains: "%" })).toEqual([]);
    expect(await pageAll(ctx, { projectContains: "_" })).toEqual([]);
  });
});
