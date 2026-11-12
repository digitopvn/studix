import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { stageAgentSelection } from "../src/studio/studio-types.ts";
import { createInMemoryStudio, testTenant } from "../src/testing/index.ts";

const agent = { runtime: "claude" as const, connectionId: "pc_1", provider: "anthropic" };

describe("createVideoProject roles", () => {
  it("lets motion-graphic take a director (premium tier) and stores it on the job", async () => {
    const env = createInMemoryStudio();
    const ctx = testTenant();
    const out = await env.studio.createVideoProject(ctx, {
      brief: { prompt: "Launch film" },
      workflowTemplate: "motion-graphic",
      roles: { director: agent },
    });
    const payload = (await env.repos.jobs.get(ctx, out.job.id))?.payload ?? {};
    expect((payload as { roles?: unknown }).roles).toEqual({ director: agent });
    expect(stageAgentSelection(payload, "motion-graphic.storyboard")).toEqual(agent);
  });

  it("refuses builder or qa roles on motion-graphic", async () => {
    const env = createInMemoryStudio();
    const err = await env.studio
      .createVideoProject(testTenant(), {
        brief: { prompt: "Launch film" },
        workflowTemplate: "motion-graphic",
        roles: { director: agent, qa: agent },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(StudixError);
    expect((err as StudixError).code).toBe("VALIDATION");
    expect((err as StudixError).message).toMatch(/director only/);
  });
});
