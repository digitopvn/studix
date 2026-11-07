import { describe, expect, it } from "vitest";
import { type Job, type Stage, stageRunOf, toJobView, type UsageEvent } from "../src/index.ts";

const tenant = { organizationId: "org_1", workspaceId: "ws_1" };
const at = new Date("2026-11-07T00:00:00.000Z");

const line = (stage: string, costCents: number, metadata: Record<string, unknown> = {}): UsageEvent =>
  ({
    ...tenant,
    id: `use_${stage}_${costCents}`,
    dedupeKey: `${stage}:${costCents}`,
    kind: "agent.run",
    quantity: 1,
    unit: "token",
    costCents,
    jobId: "job_1",
    createdAt: at,
    metadata: { stage, attempt: 1, ...metadata },
  }) as UsageEvent;

const stage = (name: string, status: Stage["status"] = "succeeded"): Stage =>
  ({ ...tenant, id: `stg_${name}`, jobId: "job_1", name, attempt: 1, status, startedAt: at }) as Stage;

const agentLine = (stage: string, costCents: number, extra: Record<string, unknown> = {}) =>
  line(stage, costCents, {
    mode: "harness",
    runtime: "claude-code-sandbox",
    model: "claude-opus-5-5",
    inputTokens: 1000,
    outputTokens: 200,
    turns: 4,
    ...extra,
  });

describe("stage run summary", () => {
  it("sums an agent stage's lines and reads its runtime, effort and connection", () => {
    const usage = [
      agentLine("script", 12.5, { agentRuntime: "claude", reasoningEffort: "xhigh", connectionId: "pc_1" }),
      agentLine("script", 2, { agentRuntime: "claude", reasoningEffort: "xhigh", connectionId: "pc_1" }),
      line("render", 40),
      line("script", 99, { attempt: 2 }),
    ];
    expect(stageRunOf(stage("script"), usage)).toEqual({
      runtime: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "xhigh",
      connectionId: "pc_1",
      costCents: 14.5,
      inputTokens: 2000,
      outputTokens: 400,
      turns: 8,
    });
  });

  it("names older lines by their runtime implementation, plain code as function and host runs as host", () => {
    expect(stageRunOf(stage("script"), [agentLine("script", 3)]).runtime).toBe("claude");
    expect(stageRunOf(stage("compose"), [line("compose", 40)])).toEqual({
      runtime: "function",
      costCents: 40,
    });
    expect(stageRunOf(stage("brief"), [])).toEqual({ runtime: "function", costCents: 0 });
    const decision = {
      ...line("plan", 10.8, {
        provider: "anthropic",
        model: "claude-opus-5-5",
        inputTokens: 90,
        outputTokens: 10,
      }),
      kind: "provider.decision",
    };
    expect(stageRunOf(stage("plan"), [decision])).toMatchObject({
      runtime: "planner",
      model: "claude-opus-5-5",
      costCents: 10.8,
      inputTokens: 90,
    });
    expect(stageRunOf(stage("script"), [line("script", 0, { mode: "host", turns: 2 })]).runtime).toBe("host");
  });

  it("labels the connection in the job view and leaves a running stage with nothing booked to the live stream", () => {
    const job = {
      ...tenant,
      id: "job_1",
      kind: "video.create",
      status: "running",
      payload: {},
      progress: 0.5,
      attempts: 1,
      maxAttempts: 3,
      cancelRequested: false,
      spentCents: 14,
      createdAt: at,
      updatedAt: at,
    } as unknown as Job;
    const view = toJobView(job, [stage("script"), stage("voice", "running")], undefined, {
      usage: [agentLine("script", 14, { agentRuntime: "pi", connectionId: "pc_1" })],
      connectionLabels: new Map([["pc_1", "Team OpenRouter"]]),
    });
    expect(view.stages[0]!.run).toMatchObject({
      runtime: "pi",
      connectionLabel: "Team OpenRouter",
      costCents: 14,
    });
    expect(view.stages[0]!.run).not.toHaveProperty("connectionId");
    expect(view.stages[1]!.run).toBeUndefined();
    expect(toJobView(job, [stage("script")]).stages[0]!.run).toBeUndefined();
  });
});
