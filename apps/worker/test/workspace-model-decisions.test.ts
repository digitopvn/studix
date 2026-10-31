import { createFakeAgentRuntime, type PiResolvedRun } from "@studix/agent-runtime";
import type {
  Job,
  ModelPreference,
  ModelSnapshotRepository,
  ProviderConnection,
  ResolvedModelSnapshot,
} from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { type DecisionRequest, FakeDecisionAdapter, RulesAdapter } from "@studix/decision-routing";
import { createLogger, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkspaceModelDecisions } from "../src/planner/workspace-model-decisions.ts";

const logger = createLogger({}, { write: () => {} });
const Decision = z.object({ answer: z.string() });

const connection: ProviderConnection = {
  id: "pconn_1",
  organizationId: "org",
  workspaceId: "ws",
  provider: "openrouter",
  label: "main",
  authMethod: "api_key",
  owner: { type: "workspace" },
  status: "connected",
  billingSource: "usage-based",
  secretRef: "cred_1",
  runtimes: ["pi"],
  version: 1,
  createdBy: { type: "user", id: "u1" },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const preference = (modelId: string): ModelPreference => ({
  id: "mpref_1",
  organizationId: "org",
  workspaceId: "ws",
  scope: { type: "workspace" },
  stage: "plan",
  runtime: "pi",
  connectionId: "pconn_1",
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

function setup(options: { prefs?: ModelPreference[]; runtimeOutput?: unknown; runtimeError?: Error } = {}) {
  const prefs = options.prefs ?? [];
  const snapshots = memorySnapshots();
  const runs: PiResolvedRun[] = [];
  const operator = new FakeDecisionAdapter({ id: "operator", steps: [{ output: { answer: "operator" } }] });
  const rules = new RulesAdapter({ rules: { "video.brief": () => ({ answer: "rules" }) } });
  const provider = createWorkspaceModelDecisions({
    operator,
    rules,
    jobs: {
      async get() {
        return { createdBy: { type: "user", id: "u1" } } as Job;
      },
    },
    connections: {
      async get(_ctx, id) {
        return id === connection.id ? connection : undefined;
      },
    },
    preferences: {
      async list() {
        return prefs;
      },
    },
    snapshots,
    vault: {
      async reveal() {
        return "tenant-key-0123456789";
      },
    },
    logger,
    runtimeFor: (resolved) => {
      runs.push(resolved);
      return createFakeAgentRuntime(() => {
        if (options.runtimeError) throw options.runtimeError;
        return { output: options.runtimeOutput ?? { answer: "workspace" }, costCents: 2, turns: 1 };
      });
    },
  });
  return { provider, operator, snapshots, runs, prefs };
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
});

describe("workspace model decisions", () => {
  it("keeps the operator router when the workspace chose no model", async () => {
    const { provider, operator, runs } = setup();
    const result = await provider.decide(request());
    expect(result.output).toEqual({ answer: "operator" });
    expect(operator.calls).toHaveLength(1);
    expect(runs).toHaveLength(0);
  });

  it("runs the workspace's own model and pins the choice to the job", async () => {
    const { provider, operator, runs, snapshots } = setup({ prefs: [preference("model/a")] });
    const result = await provider.decide(request());
    expect(result).toMatchObject({ output: { answer: "workspace" }, providerId: "pi", costCents: 2 });
    expect(runs[0]!.bindings[0]).toMatchObject({ modelId: "model/a", connectionId: "pconn_1" });
    expect([...snapshots.rows.values()][0]).toMatchObject({ stage: "plan", modelId: "model/a" });
    expect(operator.calls).toHaveLength(0);
  });

  it("keeps the pinned model on a retry after the preference changed", async () => {
    const first = setup({ prefs: [preference("model/a")] });
    await first.provider.decide(request());
    first.prefs.splice(0, 1, preference("model/b"));
    await first.provider.decide(request());
    expect(first.runs[1]!.bindings[0]!.modelId).toBe("model/a");
  });

  it("falls back to the free rules, never the operator, when the workspace model fails", async () => {
    const failing = setup({
      prefs: [preference("model/a")],
      runtimeError: new StudixError("UNAUTHENTICATED", "key rejected"),
    });
    const result = await failing.provider.decide(request());
    expect(result).toMatchObject({ output: { answer: "rules" }, fallbackReason: "auth" });
    expect(failing.operator.calls).toHaveLength(0);

    const invalid = setup({ prefs: [preference("model/a")], runtimeOutput: { wrong: true } });
    const fromInvalid = await invalid.provider.decide(request());
    expect(fromInvalid).toMatchObject({ output: { answer: "rules" }, costCents: 2 });
  });

  it("does not swallow a cancellation", async () => {
    const { provider } = setup({
      prefs: [preference("model/a")],
      runtimeError: new StudixError("CANCELLED", "stop"),
    });
    await expect(provider.decide(request())).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
