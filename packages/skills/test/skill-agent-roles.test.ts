import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageAgentSelection } from "@studix/core";
import { describe, expect, it } from "vitest";
import {
  deliveryOf,
  promptDurationMs,
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
    const { run, tasks, put } = await reviewedRun([verdict("revise"), verdict("pass")]);
    const result = await run;
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

  it("fails without a rebuild when QA could not inspect the render or left a score out", async () => {
    for (const [qa, code] of [
      [{ ...verdict("revise"), inspected: false }, "UNAVAILABLE"],
      [{ verdict: "revise", notes: "x" }, "VALIDATION"],
    ] as const) {
      const { run, tasks } = await reviewedRun([qa]);
      await expect(run).rejects.toMatchObject({ error: { code } });
      expect(tasks.map((t) => t.skill)).toEqual([SKILL_AGENT_STAGES.run, SKILL_AGENT_STAGES.qa]);
    }
  });

  it("delivers the length the brief or its prompt asks for", () => {
    expect(deliveryOf({ prompt: "5-second 16:9 teaser" }).durationMs).toBe(5000);
    expect(deliveryOf({ prompt: "video 30 giây", durationMs: 8000 }).durationMs).toBe(8000);
    expect(promptDurationMs("a 1.5 minute explainer")).toBe(90_000);
    expect(promptDurationMs("Video 15s cho quán cà phê")).toBe(15_000);
    expect(promptDurationMs("launch on 5 sites")).toBeUndefined();
    expect(deliveryOf({ prompt: "teaser" }).durationMs).toBe(10_000);
  });
});

function verdict(v: "pass" | "revise") {
  return {
    scores: { taste: 6, motion: 6, brief: 8, audio: 8 },
    overall: 6,
    verdict: v,
    notes: "ease the 3s cut",
    inspected: true,
  };
}

/** Runs the builder/QA loop on fake agents; QA answers with `qaOutputs` in turn. */
async function reviewedRun(qaOutputs: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), "roles-"));
  const video = join(dir, "video.mp4");
  await writeFile(video, "mp4");
  const tasks: { skill: string; input: Record<string, unknown> }[] = [];
  const runtime = {
    id: "fake",
    async run(_ctx: unknown, task: { skill: string; input: Record<string, unknown> }) {
      tasks.push(task);
      const output =
        task.skill === SKILL_AGENT_STAGES.qa
          ? qaOutputs.shift()
          : { video: "out/video.mp4", summary: "made", files: [video] };
      return { output, costCents: 1, inputTokens: 1, outputTokens: 1, turns: 1 };
    },
  };
  const put: string[] = [];
  const run = skillAgentReviewedRunStage.run({
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
  return { run, tasks, put };
}
