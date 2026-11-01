import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ClaudeAgentEvent,
  createFakeClaudeTransport,
  createPiSdkAgentRuntime,
  type PiResolvedRun,
} from "@studix/agent-runtime";
import { USAGE_KINDS } from "@studix/billing";
import type { ActorRef, Job, ModelPreference, ResolvedModelSnapshot, TenantContext } from "@studix/core";
import { createInMemoryUsageRepository, testTenant } from "@studix/core/testing";
import type { ModelSnapshotRepository } from "@studix/database";
import { createLogger, StudixError, systemClock } from "@studix/shared";
import { createAgentStage, type StageContext, StageSuspended, type StageUsage } from "@studix/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkerAgentHarness, type WorkerAgentHarnessDeps } from "../src/agent-harness.ts";

const logger = createLogger({}, { level: "error", write: () => {} });
const STAGE = "test.scope";
const ANTHROPIC_KEY = "sk-ant-api03-harness-test-key-000000000000";
const PI_KEY = "sk-openai-harness-test-key-0000000000";
const requester: ActorRef = { type: "user", id: "usr_owner" };

const stage = createAgentStage({
  name: STAGE,
  version: 1,
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ title: z.string() }),
  instructions: "Write a title for the topic.",
  taskInput: (input) => ({ topic: input.topic }),
  limits: { maxTurns: 4, maxTokens: 400_000, maxCostCents: 80, timeoutMs: 30_000 },
});

let server: Server;
let baseUrl = "";
const seenAuth: Array<string | undefined> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

/** An OpenAI-compatible streaming endpoint: every reply bills 100k prompt and 50k completion tokens. */
beforeAll(async () => {
  server = createServer(async (req, res) => {
    await readBody(req);
    seenAuth.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, extra: object = {}) =>
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    chunk({ content: '{"title":"Cà phê sớm mai"}' });
    res.write(
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100_000, completion_tokens: 50_000, total_tokens: 150_000 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const connections: Record<
  string,
  { provider: string; key: string; runtimes: string[]; owner: "workspace" | "user" }
> = {
  pcon_claude: { provider: "anthropic", key: ANTHROPIC_KEY, runtimes: ["claude"], owner: "workspace" },
  pcon_openai: { provider: "openai", key: PI_KEY, runtimes: ["pi"], owner: "workspace" },
  pcon_mine: { provider: "openai", key: PI_KEY, runtimes: ["pi"], owner: "user" },
};

const preference = (over: Partial<ModelPreference>): ModelPreference =>
  ({
    id: `mpref_${Math.random().toString(36).slice(2)}`,
    organizationId: "org_test",
    workspaceId: "ws_test",
    scope: { type: "workspace" },
    stage: "default",
    runtime: "pi",
    connectionId: "pcon_openai",
    provider: "openai",
    modelId: "gpt-4o-mini",
    allowFallback: false,
    fallbacks: [],
    updatedAt: new Date(),
    createdAt: new Date(),
    ...over,
  }) as ModelPreference;

function createWorld(
  options: {
    preferences?: ModelPreference[];
    claude?: boolean;
    transcript?: ClaudeAgentEvent[];
    payload?: Record<string, unknown>;
    spentCents?: number;
  } = {},
) {
  const ctx: TenantContext = testTenant();
  const usage = createInMemoryUsageRepository(systemClock);
  const preferences = [...(options.preferences ?? [])];
  const pinned = new Map<string, ResolvedModelSnapshot>();
  const snapshots: ModelSnapshotRepository = {
    async pin(_c, jobId, snapshot) {
      const key = `${jobId}:${snapshot.runtime}:${snapshot.stage}`;
      if (!pinned.has(key)) pinned.set(key, snapshot);
      return pinned.get(key)!;
    },
    async get(_c, jobId, key) {
      return pinned.get(`${jobId}:${key.runtime}:${key.stage}`);
    },
  };
  const rejected: string[] = [];
  const credentials: WorkerAgentHarnessDeps["credentials"] = {
    async resolveForExecution(_c, input) {
      const connection = connections[input.connectionId];
      if (!connection) {
        throw new StudixError("UNAVAILABLE", "The selected provider connection no longer exists", {
          retryable: false,
        });
      }
      if (!connection.runtimes.includes(input.runtime)) {
        throw new StudixError("FORBIDDEN", `not enabled for ${input.runtime}`, { retryable: false });
      }
      return {
        apiKey: connection.key,
        connection: {
          id: input.connectionId,
          provider: connection.provider,
          version: 1,
          billing: "usage_based",
          owner: connection.owner,
        },
        markRejected: async () => {
          rejected.push(input.connectionId);
        },
      } as unknown as Awaited<ReturnType<WorkerAgentHarnessDeps["credentials"]["resolveForExecution"]>>;
    },
  };
  const transport = createFakeClaudeTransport(() => options.transcript ?? []);
  const harness = createWorkerAgentHarness({
    credentials,
    preferences: {
      async list(_c, query = {}) {
        return preferences.filter(
          (p) =>
            (!query.runtime || p.runtime === query.runtime) &&
            (p.scope.type === "workspace" || p.scope.userId === query.userId),
        );
      },
    },
    snapshots,
    executions: usage,
    ...(options.claude === false ? {} : { claude: { transport, plannerModel: "claude-planner-model" } }),
    logger,
    // The real Pi SDK runtime, pointed at the fake endpoint with a declared price ($1/M in, $2/M out).
    piRuntimeFor: (resolved: PiResolvedRun) =>
      createPiSdkAgentRuntime({
        resolver: {
          resolve: async () => ({
            ...resolved,
            bindings: resolved.bindings.map((b) => ({
              ...b,
              endpoint: {
                baseUrl,
                api: "openai-completions" as const,
                models: [
                  {
                    id: b.modelId,
                    cost: { input: 1, output: 2 },
                    contextWindow: 200_000,
                    maxTokens: 1000,
                  },
                ],
              },
            })),
          }),
        },
      }),
  });

  const job = {
    id: "job_harness",
    organizationId: ctx.organizationId,
    workspaceId: ctx.workspaceId,
    kind: "video.create",
    status: "running",
    payload: options.payload ?? {},
    createdBy: requester,
    attempts: 1,
    spentCents: options.spentCents ?? 0,
    budgetCents: 500,
  } as unknown as Job;

  const run = async () => {
    const sctx = {
      ctx,
      job,
      attempt: 1,
      signal: new AbortController().signal,
      outputs: {},
      input: { topic: "cà phê" },
    } as unknown as StageContext;
    sctx.agents = {
      runtime: harness.runtimeFor(sctx),
      latestHandoff: async () => undefined,
      latestOverrun: async () => undefined,
      grantedOverruns: async () => 0,
      consumeOverrun: async () => {},
    };
    return stage.run(sctx);
  };
  const executions = async () => (await usage.listProviderExecutions(ctx, { jobId: job.id })).items;
  return { run, executions, transport, pinned, preferences, rejected, harness };
}

const claudeTurn = (costUsd: number): ClaudeAgentEvent[] => [
  { type: "usage", turns: 1, inputTokens: 1200, outputTokens: 300, costUsd, model: "claude-sonnet-test" },
  { type: "result", output: { title: "Cà phê sớm mai" } },
];

function agentLine(usage: readonly StageUsage[] | undefined): StageUsage {
  expect(usage).toHaveLength(1);
  const line = usage![0]!;
  expect(line.kind).toBe(USAGE_KINDS.agentRun);
  return line;
}

describe("worker agent harness", () => {
  it("runs a harness stage on Claude with the workspace's Anthropic key and bills its real cost", async () => {
    const world = createWorld({
      preferences: [
        preference({
          runtime: "claude",
          connectionId: "pcon_claude",
          provider: "anthropic",
          modelId: "claude-sonnet-test",
        }),
      ],
      transcript: claudeTurn(0.034),
    });
    const result = await world.run();

    expect(result.output).toEqual({ title: "Cà phê sớm mai" });
    const line = agentLine(result.usage);
    expect(line.costCents).toBeCloseTo(3.4);
    expect(line.quantity).toBe(1500);
    expect(line.metadata).toMatchObject({ mode: "harness", runtime: "claude-agent-sdk" });
    expect(world.transport.requests[0]).toMatchObject({
      credential: ANTHROPIC_KEY,
      model: "claude-sonnet-test",
    });

    const [execution] = await world.executions();
    expect(line.providerExecutionId).toBe(execution!.id);
    expect(execution).toMatchObject({
      provider: "anthropic",
      operation: STAGE,
      status: "succeeded",
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(execution!.costCents).toBeCloseTo(3.4);
    // The workspace's own key paid: recorded as workspace-funded, never as operator spend.
    expect(line.funding).toBe("workspace");
    expect(execution!.funding).toBe("workspace");
    expect(world.pinned.get(`job_harness:claude:${STAGE}`)).toMatchObject({
      connectionId: "pcon_claude",
      modelId: "claude-sonnet-test",
      source: "workspace-default",
      billingSource: "usage_based",
    });
  });

  it("runs a harness stage on the Pi SDK with the workspace's key and bills its real token cost", async () => {
    const world = createWorld({ preferences: [preference({})] });
    seenAuth.length = 0;
    const result = await world.run();

    expect(result.output).toEqual({ title: "Cà phê sớm mai" });
    expect(seenAuth).toEqual([`Bearer ${PI_KEY}`]);
    const line = agentLine(result.usage);
    // 100k input tokens at $1/M plus 50k output tokens at $2/M.
    expect(line.costCents).toBeCloseTo(20);
    expect(line.quantity).toBe(150_000);
    expect(line.metadata).toMatchObject({ runtime: "pi", model: "openai/gpt-4o-mini" });
    const [execution] = await world.executions();
    expect(line.providerExecutionId).toBe(execution!.id);
    expect(execution).toMatchObject({ provider: "pi", status: "succeeded", inputTokens: 100_000 });
    expect(execution!.costCents).toBeCloseTo(20);
    expect(world.pinned.get(`job_harness:pi:${STAGE}`)).toMatchObject({ connectionId: "pcon_openai" });
    expect(line.funding).toBe("workspace");
    expect(execution!.funding).toBe("workspace");
  });

  it("tags a run on the requester's personal key as member-funded", async () => {
    const world = createWorld({
      preferences: [preference({ connectionId: "pcon_mine", scope: { type: "user", userId: requester.id } })],
    });
    const line = agentLine((await world.run()).usage);
    const [execution] = await world.executions();
    expect(line.funding).toBe("member");
    expect(execution).toMatchObject({ funding: "member" });
    expect(line.costCents).toBeCloseTo(20);
  });

  it("still caps a BYOK run at what is left of the job budget", async () => {
    const world = createWorld({
      preferences: [preference({ runtime: "claude", connectionId: "pcon_claude", provider: "anthropic" })],
      // 500 budget, 470 already spent: the 80-cent stage cap drops to 30 cents.
      spentCents: 470,
      transcript: claudeTurn(0.01),
    });
    await world.run();
    expect(world.transport.requests[0]).toMatchObject({ maxBudgetUsd: 0.3 });
  });

  it("prefers the more specific choice across runtimes and Pi on a tie", async () => {
    const claudeDefault = preference({
      runtime: "claude",
      connectionId: "pcon_claude",
      provider: "anthropic",
      modelId: "claude-sonnet-test",
      scope: { type: "user", userId: requester.id },
    });
    const personal = createWorld({
      preferences: [preference({}), claudeDefault],
      transcript: claudeTurn(0.01),
    });
    expect(agentLine((await personal.run()).usage).metadata).toMatchObject({ runtime: "claude-agent-sdk" });

    const tie = createWorld({
      preferences: [preference({}), { ...claudeDefault, scope: { type: "workspace" } }],
      transcript: claudeTurn(0.01),
    });
    expect(agentLine((await tie.run()).usage).metadata).toMatchObject({ runtime: "pi" });
    expect(tie.transport.requests).toHaveLength(0);
  });

  it("keeps the pinned model when the preference changes between attempts", async () => {
    const world = createWorld({
      preferences: [
        preference({
          runtime: "claude",
          connectionId: "pcon_claude",
          provider: "anthropic",
          modelId: "claude-a",
        }),
      ],
      transcript: claudeTurn(0.01),
    });
    await world.run();
    world.preferences.splice(0, 1, preference({}));
    await world.run();
    expect(world.transport.requests.map((r) => r.model)).toEqual(["claude-a", "claude-a"]);
  });

  it("runs the agent stages of a job that selected the Claude planner on that connection", async () => {
    const world = createWorld({
      preferences: [preference({})],
      payload: { planner: { runtime: "claude", providerConnectionId: "pcon_claude" } },
      transcript: claudeTurn(0.02),
    });
    const result = await world.run();
    expect(agentLine(result.usage).costCents).toBeCloseTo(2);
    expect(world.transport.requests[0]).toMatchObject({
      credential: ANTHROPIC_KEY,
      model: "claude-planner-model",
    });
  });

  it("fails UNAVAILABLE without a chosen model, and never pays for anything", async () => {
    const world = createWorld({ transcript: claudeTurn(0.01) });
    await expect(world.run()).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: false });
    expect(world.transport.requests).toHaveLength(0);
    expect(await world.executions()).toHaveLength(0);
  });

  it("fails UNAVAILABLE when the choice is Claude and this worker does not run it", async () => {
    const world = createWorld({
      claude: false,
      preferences: [preference({ runtime: "claude", connectionId: "pcon_claude", provider: "anthropic" })],
    });
    await expect(world.run()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("does not run"),
    });
  });

  it("bills a capped run against its failed provider execution and parks for an overrun", async () => {
    const world = createWorld({
      preferences: [preference({ runtime: "claude", connectionId: "pcon_claude", provider: "anthropic" })],
      // 95 cents reported in one turn: over the stage's 80-cent cap.
      transcript: claudeTurn(0.95),
    });
    const parked = await world.run().catch((e: unknown) => e);
    expect(parked).toBeInstanceOf(StageSuspended);
    const line = agentLine((parked as StageSuspended).usage);
    expect(line.costCents).toBeGreaterThan(0);
    const [execution] = await world.executions();
    expect(execution).toMatchObject({ status: "failed", provider: "anthropic" });
    expect(line.providerExecutionId).toBe(execution!.id);
    expect(line.metadata).toMatchObject({ cap: "cost" });
    expect(line.funding).toBe("workspace");
    expect(execution!.funding).toBe("workspace");
  });

  it("marks a Claude key the provider rejects", async () => {
    const world = createWorld({
      preferences: [preference({ runtime: "claude", connectionId: "pcon_claude", provider: "anthropic" })],
      transcript: [{ type: "error", status: 401, message: "invalid x-api-key" }],
    });
    await expect(world.run()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(world.rejected).toEqual(["pcon_claude"]);
    expect(await world.executions()).toMatchObject([{ status: "failed" }]);
    expect(await world.harness.idle(1000)).toBe(true);
  });
});
