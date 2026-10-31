import { readFileSync } from "node:fs";
import type { ProjectStatus, TenantContext } from "@studix/core";
import { createInMemoryProjectRepository } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { animePack, FilmScope, type FilmScopeInput, filmStageNames, scopeDurationMs } from "../src/index.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};
const actor = { type: "user", id: "usr_1" } as const;
const scope = FilmScope.parse(
  JSON.parse(
    readFileSync(new URL("./fixtures/anime-scope-vi.json", import.meta.url), "utf8"),
  ) as FilmScopeInput,
);
const names = filmStageNames("anime");
const brief = {
  prompt: "Phim ngắn",
  title: "Phim",
  language: "vi",
  aspectRatio: "16:9",
  durationMs: scopeDurationMs(scope),
};

/** Runs the free G0 stage of the anime pack against a project that is in `status` when the stage commits. */
async function runBible(status: ProjectStatus) {
  const projects = createInMemoryProjectRepository({ now: () => new Date() });
  const project = await projects.create(ctx, {
    title: "Phim",
    status: "draft",
    brief,
    workflowTemplate: "anime",
    createdBy: actor,
  } as never);
  const head = await projects.createVersion(ctx, {
    projectId: project.id,
    ir: { id: "head" },
    source: "planner",
    createdBy: actor,
    advanceFrom: undefined,
  } as never);
  await projects.update(ctx, project.id, { currentVersionId: head.id, status });
  const stage = animePack.stages?.find((s) => s.name === names.bible);
  const out = (await stage?.run({
    job: { id: "job_stale1", payload: { projectId: project.id } },
    input: { outputs: { brief: { brief }, [names.scope]: { scope } } },
    commit: async (write: (r: never, c: TenantContext) => Promise<unknown>) =>
      write({ projects } as never, ctx),
  } as never)) as { output: { reviewVersionId: string } };
  return {
    versions: (await projects.listVersions(ctx, project.id)).items.length,
    project: (await projects.get(ctx, project.id))!,
    headId: head.id,
    review: out.output.reviewVersionId,
  };
}

describe("narrative-film review board", () => {
  it.each(["draft", "planning", "rendering", "in_review"] as const)(
    "points a %s project at the board and hands it to review",
    async (status) => {
      const r = await runBible(status);
      expect(r.project.status).toBe("in_review");
      expect(r.project.currentVersionId).toBe(r.review);
    },
  );

  it.each(["approved", "published", "archived", "failed"] as const)(
    "leaves a %s project and its head alone when a stale job reaches G0",
    async (status) => {
      const r = await runBible(status);
      expect(r.project.status).toBe(status);
      expect(r.project.currentVersionId).toBe(r.headId);
      // The board is still stored next to the head, only the pointer and status stay put.
      expect(r.versions).toBe(2);
    },
  );
});
