import {
  createFakeAgentRuntime,
  type PiCredentialSource,
  type PiResolvedRun,
  withSpend,
} from "@studix/agent-runtime";
import type { Job, ModelPreference, ResolvedModelSnapshot } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import type { ModelSnapshotRepository } from "@studix/database";
import {
  type DecisionExecutionRecord,
  type DecisionRequest,
  FakeDecisionAdapter,
  RulesAdapter,
} from "@studix/decision-routing";
import { createLogger, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkspaceModelDecisions } from "../src/planner/workspace-model-decisions.ts";

const logger = createLogger({}, { write: () => {} });
const Decision = z.object({ answer: z.string() });

const preference = (modelId: string): ModelPreference => ({
  id: "mpref_1",
  organizationId: "org",
  workspaceId: "ws",
  scope: { type: "workspace" },
  stage: "plan",
  runtime: "pi",
  connectionId: "pcon_1",
  provider: "openrouter",
  modelId,
  allowFallback: false,
  fallbacks: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

function memorySnapshots(): ModelSnapshotRepository & { rows: Map<string, ResolvedModelSnapshot> } {
  const rows = new Map<string, ResolvedModelSnapshot>();
  return {
    rows,
    async pin(_ctx, jobId, snapshot) {
      const key = `${jobId}/${snapshot.runtime}/${snapshot.stage}`;
      if (!rows.has(key)) rows.set(key, snapshot);
      return rows.get(key)!;
    },
    async get(_ctx, jobId, key) {
      return rows.get(`${jobId}/${key.runtime}/${key.stage}`);
    },
  };
}

function setup(
  options: {
    prefs?: ModelPreference[];
    runtimeOutput?: unknown;
    runtimeError?: Error;
    credentialError?: Error;
    owner?: "workspace" | "user";
    sinkDown?: boolean;
  } = {},
) {
  const prefs = options.prefs ?? [];
  const snapshots = memorySnapshots();
  const runs: PiResolvedRun[] = [];
  const executions: DecisionExecutionRecord[] = [];
  const operator = new FakeDecisionAdapter({ id: "operator", steps: [{ output: { answer: "operator" } }] });
  const rules = new RulesAdapter({ rules: { "video.brief": () => ({ answer: "rules" }) } });
  const credentials: PiCredentialSource = {
    async resolveForExecution(_ctx, input) {
      if (options.credentialError) throw options.credentialError;
      return {
        apiKey: "tenant-key-0123456789",
        connection: {
          id: input.connectionId,
          provider: "openrouter",
          version: 1,
          billing: "usage_based",
          owner: options.owner ?? "workspace",
        },
        async markRejected() {},
      };
    },
  };
  const provider = createWorkspaceModelDecisions({
    operator,
    rules,
    jobs: {
      async get() {
        return { createdBy: { type: "user", id: "u1" } } as Job;
      },
    },
    credentials,
    preferences: {
      async list() {
        return prefs;
      },
    },
    snapshots,
    sink: {
      record(_ctx, execution) {
        if (options.sinkDown) throw new Error("database unavailable");
        executions.push(execution);
      },
    },
    logger,
    runtimeFor: (resolved) => {
      runs.push(resolved);
      return createFakeAgentRuntime(() => {
        if (options.runtimeError) throw options.runtimeError;
        return {
          output: options.runtimeOutput ?? { answer: "workspace" },
          costCents: 2,
          turns: 1,
          inputTokens: 10,
          outputTokens: 5,
          model: "openrouter/model",
        };
      });
    },
  });
  return { provider, operator, snapshots, runs, prefs, executions };
}

const request = (): DecisionRequest<z.infer<typeof Decision>> => ({
  kind: "video.brief",
  tenant: testTenant(),
  input: { prompt: "coffee" },
  schema: Decision,
  budgetCents: 5,
  timeoutMs: 5_000,
  idempotencyKey: "job_1:video.brief",
  jobId: "job_1",
  stageId: "plan",
});

describe("workspace model decisions", () => {
  it("keeps the operator router when nobody chose a model", async () => {
    const { provider, operator, runs, executions } = setup();
    const result = await provider.decide(request());
    expect(result.output).toEqual({ answer: "operator" });
    expect(operator.calls).toHaveLength(1);
    expect(runs).toHaveLength(0);
    expect(executions).toHaveLength(0);
  });

  it("runs the chosen model, pins it to the job and records the execution", async () => {
    const { provider, operator, runs, snapshots, executions } = setup({ prefs: [preference("model/a")] });
    const result = await provider.decide(request());
    expect(result).toMatchObject({
      output: { answer: "workspace" },
      providerId: "pi",
      costCents: 2,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(runs[0]!.bindings[0]).toMatchObject({ modelId: "model/a", connectionId: "pcon_1" });
    expect([...snapshots.rows.values()][0]).toMatchObject({ stage: "plan", modelId: "model/a" });
    expect(operator.calls).toHaveLength(0);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      provider: "pi",
      status: "succeeded",
      costCents: 2,
      jobId: "job_1",
      funding: "workspace",
    });
    expect(result.providerExecutionId).toBe(executions[0]!.id);
    expect(result.funding).toBe("workspace");
  });

  it("keeps a failed run's funding when its execution cannot be recorded", async () => {
    const { provider } = setup({
      prefs: [preference("model/a")],
      owner: "user",
      sinkDown: true,
      runtimeError: withSpend(new StudixError("PROVIDER_ERROR", "outage"), {
        costCents: 3,
        inputTokens: 7,
        outputTokens: 1,
        turns: 1,
      }),
    });
    const result = await provider.decide(request());
    expect(result.costCents).toBe(3);
    expect(result.providerExecutionId).toBeUndefined();
    expect(result.funding).toBe("member");
  });

  it("tags a decision on a member's personal key as member-funded", async () => {
    const { provider, executions } = setup({ prefs: [preference("model/a")], owner: "user" });
    const result = await provider.decide(request());
    expect(executions[0]).toMatchObject({ status: "succeeded", funding: "member" });
    expect(result.funding).toBe("member");
  });

  it("keeps the pinned model on a retry after the preference changed", async () => {
    const first = setup({ prefs: [preference("model/a")] });
    await first.provider.decide(request());
    first.prefs.splice(0, 1, preference("model/b"));
    await first.provider.decide(request());
    expect(first.runs[1]!.bindings[0]!.modelId).toBe("model/a");
  });

  it("falls back to the free rules, never the operator, when the chosen model fails", async () => {
    const failing = setup({
      prefs: [preference("model/a")],
      runtimeError: new StudixError("UNAUTHENTICATED", "key rejected"),
    });
    const result = await failing.provider.decide(request());
    expect(result).toMatchObject({ output: { answer: "rules" }, fallbackReason: "auth" });
    expect(failing.operator.calls).toHaveLength(0);
    expect(failing.executions[0]).toMatchObject({ provider: "pi", status: "failed" });

    const invalid = setup({ prefs: [preference("model/a")], runtimeOutput: { wrong: true } });
    const fromInvalid = await invalid.provider.decide(request());
    expect(fromInvalid).toMatchObject({
      output: { answer: "rules" },
      costCents: 2,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(fromInvalid.providerExecutionId).toBe(invalid.executions[0]!.id);
  });

  it("treats a key that cannot be released as a failing model, not as no choice", async () => {
    const { provider, operator } = setup({
      prefs: [preference("model/a")],
      credentialError: new StudixError("FORBIDDEN", "This key is not enabled for the pi runtime"),
    });
    const result = await provider.decide(request());
    expect(result).toMatchObject({ output: { answer: "rules" }, fallbackReason: "auth" });
    expect(operator.calls).toHaveLength(0);
  });

  it("does not call the provider when the decision has no budget", async () => {
    const { provider, runs } = setup({ prefs: [preference("model/a")] });
    const result = await provider.decide({ ...request(), budgetCents: 0 });
    expect(result).toMatchObject({ output: { answer: "rules" }, fallbackReason: "budget_exceeded" });
    expect(runs).toHaveLength(0);
  });

  it("bills the spend a failed run reported, tokens included", async () => {
    const { provider, executions } = setup({
      prefs: [preference("model/a")],
      runtimeError: withSpend(new StudixError("PROVIDER_ERROR", "outage"), {
        costCents: 3,
        inputTokens: 7,
        outputTokens: 1,
        turns: 1,
      }),
    });
    const result = await provider.decide(request());
    expect(result).toMatchObject({
      output: { answer: "rules" },
      costCents: 3,
      usage: { inputTokens: 7, outputTokens: 1 },
    });
    expect(executions[0]).toMatchObject({ status: "failed", costCents: 3, funding: "workspace" });
    expect(result).toMatchObject({ providerExecutionId: executions[0]!.id, funding: "workspace" });
  });

  it("runs the route another attempt pinned first", async () => {
    const { provider, snapshots, runs } = setup({ prefs: [preference("model/b")] });
    const original = snapshots.get.bind(snapshots);
    let raced = false;
    // The first read sees no pin; a concurrent attempt then pins model/a before this one does.
    snapshots.get = async (ctx, jobId, key) => {
      const found = await original(ctx, jobId, key);
      if (!raced) {
        raced = true;
        snapshots.rows.set(`${jobId}/pi/plan`, {
          runtime: "pi",
          stage: "plan",
          source: "workspace-stage",
          connectionId: "pcon_1",
          connectionVersion: 1,
          provider: "openrouter",
          modelId: "model/a",
          billingSource: "usage_based",
          allowFallback: false,
          fallbacks: [],
        });
      }
      return found;
    };
    await provider.decide(request());
    expect(runs.at(-1)!.bindings[0]!.modelId).toBe("model/a");
  });

  it("does not swallow a cancellation", async () => {
    const { provider } = setup({
      prefs: [preference("model/a")],
      runtimeError: new StudixError("CANCELLED", "stop"),
    });
    await expect(provider.decide(request())).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
