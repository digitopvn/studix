import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageAgentSelection } from "@studix/core";
import { describe, expect, it } from "vitest";
import {
  SKILL_AGENT_STAGES,
  skillAgentPipeline,
  skillAgentReviewedRunStage,
} from "../src/skill-agent/skill-agent-pack.ts";

const pi = {
  runtime: "pi" as const,
  connectionId: "pc_1",
  provider: "deepseek",
  modelId: "deepseek-v4.1-flash",
};
const claude = { runtime: "claude" as const, connectionId: "pc_2", provider: "anthropic" };
const names = (payload: unknown) =>
  skillAgentPipeline
    .stages({ fromVersion: false, payload }, { brief: { name: "brief" } } as never)
    .map((s) => s?.name);

describe("skill-agent roles", () => {
  it("runs each role's stage on its own agent, the rest on the job's agent", () => {
    const payload = { agent: claude, roles: { builder: pi, qa: claude } };
    expect(stageAgentSelection(payload, SKILL_AGENT_STAGES.run)).toEqual(pi);
    expect(stageAgentSelection(payload, SKILL_AGENT_STAGES.director)).toEqual(claude);
    expect(stageAgentSelection({}, SKILL_AGENT_STAGES.run)).toBeUndefined();
  });

  it("adds the director and the QA loop only when the job names those roles", () => {
    expect(names({})).toContain(SKILL_AGENT_STAGES.run);
    expect(names({})).not.toContain(SKILL_AGENT_STAGES.director);
    const withRoles = names({ roles: { director: claude, qa: claude } });
    expect(withRoles.slice(0, 3)).toEqual(["brief", SKILL_AGENT_STAGES.director, SKILL_AGENT_STAGES.run]);
  });

  it("sends the render back while QA asks for a revision, and records every score", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roles-"));
    const video = join(dir, "video.mp4");
    await writeFile(video, "mp4");
    const tasks: { skill: string; input: Record<string, unknown> }[] = [];
    const verdicts = ["revise", "pass"];
    const runtime = {
      id: "fake",
      async run(_ctx: unknown, task: { skill: string; input: Record<string, unknown> }) {
        tasks.push(task);
        const output =
          task.skill === SKILL_AGENT_STAGES.qa
            ? {
                scores: { taste: 6, motion: 6, brief: 8, audio: 8 },
                overall: 6,
                verdict: verdicts.shift(),
                notes: "ease the 3s cut",
              }
            : { video: "out/video.mp4", summary: "made", files: [video] };
        return { output, costCents: 1, inputTokens: 1, outputTokens: 1, turns: 1 };
      },
    };
    const put: string[] = [];
    const result = await skillAgentReviewedRunStage.run({
      job: { id: "job_1", payload: {}, budgetCents: 1000, spentCents: 0 },
      input: { outputs: { brief: { brief: { prompt: "x" } } } },
      ctx: {},
      signal: new AbortController().signal,
      services: {
        storage: {
          put: async (_c: unknown, key: string) => put.push(key),
          signedUrl: async (_c: unknown, key: string) => `https://r2/${key}`,
        },
      },
      agents: { runtime, latestOverrun: async () => undefined, grantedOverruns: async () => 0 },
    } as never);
    const review = (result.output as { review: { rounds: { verdict: string }[] } }).review;
    expect(review.rounds.map((r) => r.verdict)).toEqual(["revise", "pass"]);
    expect(put).toEqual(["generated/job_1/skill-agent/qa-r1.mp4", "generated/job_1/skill-agent/qa-r2.mp4"]);
    expect(tasks.map((t) => t.skill)).toEqual([
      SKILL_AGENT_STAGES.run,
      SKILL_AGENT_STAGES.qa,
      SKILL_AGENT_STAGES.run,
      SKILL_AGENT_STAGES.qa,
    ]);
    expect(tasks[2]?.input.revision).toEqual({ round: 2, notes: "ease the 3s cut" });
    expect(result.usage).toHaveLength(4);
  });
});
