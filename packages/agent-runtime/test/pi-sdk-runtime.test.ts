import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ActorRef, AgentTask, ModelPreference, ResolvedModelSnapshot } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentSpendOf,
  createPiKeyTester,
  createPiSdkAgentRuntime,
  createProviderBindingResolver,
  isNoModelSelected,
  listPiCatalog,
  type PiBindingResolver,
  type PiCredentialSource,
  type PiRunBinding,
} from "../src/index.ts";

interface Seen {
  auth: string | undefined;
  body: { model?: string };
}

let server: Server;
let baseUrl = "";
const seen: Seen[] = [];
let respond: (seen: Seen) => { status: number; text?: string } = () => ({ status: 200, text: '{"ok":true}' });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

/** An OpenAI-compatible streaming endpoint: every reply bills 1M prompt tokens. */
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const entry: Seen = { auth: req.headers.authorization, body: JSON.parse((await readBody(req)) || "{}") };
    seen.push(entry);
    const plan = respond(entry);
    if (plan.status !== 200) {
      res.writeHead(plan.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `status ${plan.status} from provider` } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object) =>
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    chunk({ content: plan.text ?? "" });
    res.write(
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const binding = (over: Partial<PiRunBinding> = {}): PiRunBinding => ({
  provider: "acme",
  modelId: "acme-1",
  apiKey: "runtime-key-0123456789",
  connectionId: "pcon_1",
  endpoint: {
    baseUrl,
    api: "openai-completions",
    // $1 per million input tokens, so each fake reply costs 100 cents.
    models: [{ id: "acme-1", cost: { input: 1, output: 1 }, contextWindow: 8000, maxTokens: 1000 }],
  },
  ...over,
});

const staticResolver = (...bindings: PiRunBinding[]): PiBindingResolver => ({
  async resolve() {
    return { bindings };
  },
});

const task = (over: Partial<AgentTask> = {}): AgentTask => ({
  skill: "plan",
  instructions: "Plan it",
  input: { prompt: "coffee" },
  maxCostCents: 500,
  maxTurns: 3,
  ...over,
});

describe("Pi SDK runtime", () => {
  it("runs the real SDK against the resolved binding with only that runtime key", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, text: '```json\n{"ok":true}\n```' });
    const runtime = createPiSdkAgentRuntime({ resolver: staticResolver(binding()) });
    const result = await runtime.run(testTenant(), task({ outputSchema: { type: "object" } }));
    expect(result.output).toEqual({ ok: true });
    expect(result.model).toBe("acme/acme-1");
    expect(result.costCents).toBeCloseTo(100, 0);
    expect(result.turns).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer runtime-key-0123456789");
    expect(seen[0]!.body.model).toBe("acme-1");
  });

  it("stops at the bounded runtime's cost cap and carries the spend", async () => {
    respond = () => ({ status: 200, text: "x" });
    const runtime = createPiSdkAgentRuntime({ resolver: staticResolver(binding()) });
    const error = await runtime.run(testTenant(), task({ maxCostCents: 10 })).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BUDGET_EXCEEDED", details: { cap: "cost" } });
    expect(agentSpendOf(error)?.costCents).toBeCloseTo(100, 0);
  });

  it("maps a rejected credential to UNAUTHENTICATED, reports it, and tries every supplied binding", async () => {
    seen.length = 0;
    respond = () => ({ status: 401 });
    const rejected: string[] = [];
    const runtime = createPiSdkAgentRuntime({
      resolver: staticResolver(
        binding({ markRejected: async () => void rejected.push("pcon_1") }),
        binding({ connectionId: "pcon_2", apiKey: "other-key-0123456789" }),
      ),
    });
    const error = await runtime.run(testTenant(), task()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(JSON.stringify((error as StudixError).toJSON?.() ?? error)).not.toContain(
      "runtime-key-0123456789",
    );
    expect(seen).toHaveLength(2);
    expect(rejected).toEqual(["pcon_1"]);
  });

  it("tries the next explicit binding only after a provider failure, and reports which one ran", async () => {
    seen.length = 0;
    respond = (s) => (s.auth?.includes("bad-key") ? { status: 500 } : { status: 200, text: '{"ok":1}' });
    const snapshot = { connectionId: "pcon_1" } as ResolvedModelSnapshot;
    const runtime = createPiSdkAgentRuntime({
      resolver: {
        async resolve() {
          return {
            snapshot,
            bindings: [
              binding({ apiKey: "bad-key-0123456789", funding: "member" }),
              binding({ connectionId: "pcon_2", apiKey: "good-key-0123456789", funding: "workspace" }),
            ],
          };
        },
      },
    });
    const result = await runtime.run(testTenant(), task({ outputSchema: { type: "object" } }));
    expect(result.output).toEqual({ ok: 1 });
    expect(seen.map((s) => s.auth)).toContain("Bearer good-key-0123456789");
    expect(result.resolved).toEqual({ connectionId: "pcon_2", snapshot, usedFallback: true });
    expect(result.funding).toBe("workspace");
  });

  it("never sends an empty tenant key and never reads the server environment", async () => {
    seen.length = 0;
    process.env.OPENAI_API_KEY = "operator-env-key-0123456789";
    try {
      const runtime = createPiSdkAgentRuntime({
        resolver: staticResolver(binding({ provider: "openai", apiKey: "  " })),
      });
      await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(seen).toHaveLength(0);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("does not fall back when the model answers badly, and the bad answer's spend is kept", async () => {
    seen.length = 0;
    respond = () => ({ status: 200, text: "not json at all" });
    const runtime = createPiSdkAgentRuntime({
      resolver: staticResolver(
        binding({ funding: "member" }),
        binding({ connectionId: "pcon_2", apiKey: "second-key-0123456789", funding: "workspace" }),
      ),
    });
    const error = await runtime
      .run(testTenant(), task({ outputSchema: { type: "object" } }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "VALIDATION" });
    expect(agentSpendOf(error)?.costCents).toBeCloseTo(100, 0);
    // The spend is tagged with the connection that paid it.
    expect(error).toMatchObject({ details: { funding: "member" } });
    expect(seen).toHaveLength(1);
  });

  it("makes no provider call when cancelled while the binding is still resolving", async () => {
    seen.length = 0;
    const controller = new AbortController();
    const slow: PiBindingResolver = {
      async resolve() {
        await new Promise((r) => setTimeout(r, 40));
        return { bindings: [binding()] };
      },
    };
    const running = createPiSdkAgentRuntime({ resolver: slow }).run(
      testTenant(),
      task({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 10);
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toHaveLength(0);
  });

  it("rejects tools", async () => {
    const runtime = createPiSdkAgentRuntime({ resolver: staticResolver(binding()) });
    await expect(
      runtime.run(testTenant(), task({ tools: [{ name: "shell", description: "x", inputSchema: {} }] })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("Pi key tester", () => {
  const runtimeFor = () => (b: PiRunBinding) =>
    createPiSdkAgentRuntime({ resolver: staticResolver(binding({ apiKey: b.apiKey })) });

  it("counts a reply stopped only by the one-cent cap as a working key", async () => {
    respond = () => ({ status: 200, text: "OK" });
    const result = await createPiKeyTester({ runtimeFor: runtimeFor() }).test(
      "probe-key-0123456789",
      "openai",
    );
    expect(result).toMatchObject({ ok: true, verdict: "available" });
  });

  it("reports a rejected key as invalid without echoing it", async () => {
    respond = () => ({ status: 401 });
    const result = await createPiKeyTester({ runtimeFor: runtimeFor() }).test(
      "probe-key-0123456789",
      "openai",
    );
    expect(result).toMatchObject({ ok: false, verdict: "invalid", error: { code: "UNAUTHENTICATED" } });
    expect(JSON.stringify(result)).not.toContain("probe-key-0123456789");
  });

  it("leaves a provider outage and an unknown provider unverified", async () => {
    respond = () => ({ status: 500 });
    const tester = createPiKeyTester({ runtimeFor: runtimeFor() });
    expect((await tester.test("probe-key-0123456789", "openai")).verdict).toBe("unverified");
    expect((await tester.test("probe-key-0123456789", "amazon-bedrock")).verdict).toBe("unverified");
  });
});

const ctx = () => ({ ...testTenant(), actor: { type: "system" as const, id: "worker" } });

const preference = (over: Partial<ModelPreference> = {}): ModelPreference => ({
  id: "mpref_1",
  organizationId: "org",
  workspaceId: "ws",
  scope: { type: "workspace" },
  stage: "default",
  runtime: "pi",
  connectionId: "pcon_1",
  provider: "openrouter",
  modelId: "some/model",
  allowFallback: false,
  fallbacks: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

interface FakeConnection {
  id: string;
  provider: string;
  ownerUserId?: string;
  runtimes: string[];
}

/** Mirrors the connection service's rules: owner-only personal keys, runtime opt-in. */
function credentialsFor(conns: FakeConnection[]) {
  const released: string[] = [];
  const credentials: PiCredentialSource = {
    async resolveForExecution(_ctx, input) {
      const conn = conns.find((c) => c.id === input.connectionId);
      if (!conn) throw new StudixError("UNAVAILABLE", "gone");
      if (
        conn.ownerUserId &&
        !(input.requestedBy.type === "user" && input.requestedBy.id === conn.ownerUserId)
      ) {
        throw new StudixError("FORBIDDEN", "not yours");
      }
      if (!conn.runtimes.includes(input.runtime)) throw new StudixError("FORBIDDEN", "not enabled");
      released.push(conn.id);
      return {
        apiKey: `secret-for-${conn.id}-0123456789`,
        connection: {
          id: conn.id,
          provider: conn.provider,
          version: 3,
          billing: "usage_based",
          owner: conn.ownerUserId ? "user" : "workspace",
        },
        async markRejected() {},
      };
    },
  };
  return { credentials, released };
}

const shared: FakeConnection = { id: "pcon_1", provider: "openrouter", runtimes: ["pi"] };

function resolverFor(
  conns: FakeConnection[],
  prefs: ModelPreference[],
  extra: { requestedBy?: ActorRef; snapshot?: ResolvedModelSnapshot } = {},
) {
  const { credentials, released } = credentialsFor(conns);
  const queries: unknown[] = [];
  const resolver = createProviderBindingResolver({
    credentials,
    preferences: {
      async list(_ctx, query) {
        queries.push(query);
        return prefs;
      },
    },
    requestedBy: extra.requestedBy ?? { type: "user", id: "u1" },
    ...(extra.snapshot ? { snapshot: extra.snapshot } : {}),
  });
  return { resolver, released, queries };
}

describe("provider binding resolver", () => {
  it("binds the preferred connection for the job's requester and snapshots the choice", async () => {
    const { resolver, released, queries } = resolverFor([shared], [preference()]);
    const run = await resolver.resolve(ctx(), { stage: "plan" });
    expect(run.bindings).toHaveLength(1);
    expect(run.bindings[0]).toMatchObject({
      provider: "openrouter",
      modelId: "some/model",
      connectionId: "pcon_1",
    });
    expect(run.snapshot).toMatchObject({
      source: "workspace-default",
      connectionVersion: 3,
      billingSource: "usage_based",
    });
    expect(released).toEqual(["pcon_1"]);
    expect(queries).toEqual([{ runtime: "pi", userId: "u1" }]);
  });

  it("fails clearly when no model is chosen or the key is not enabled for Pi", async () => {
    const none = await resolverFor([shared], [])
      .resolver.resolve(ctx(), { stage: "plan" })
      .catch((e: unknown) => e);
    expect(none).toMatchObject({ code: "UNAVAILABLE" });
    expect(isNoModelSelected(none)).toBe(true);
    const claudeOnly = await resolverFor([{ ...shared, runtimes: ["claude"] }], [preference()])
      .resolver.resolve(ctx(), { stage: "plan" })
      .catch((e: unknown) => e);
    expect(claudeOnly).toMatchObject({ code: "FORBIDDEN" });
    expect(isNoModelSelected(claudeOnly)).toBe(false);
  });

  it("uses fallbacks only with consent and never releases a personal key for another user's job", async () => {
    const personal: FakeConnection = {
      id: "pcon_p",
      provider: "openrouter",
      ownerUserId: "u_owner",
      runtimes: ["pi"],
    };
    const fb = { connectionId: "pcon_p", provider: "openrouter", modelId: "other/model" };
    const withoutConsent = resolverFor([shared, personal], [preference({ fallbacks: [fb] })]);
    expect((await withoutConsent.resolver.resolve(ctx(), { stage: "plan" })).bindings).toHaveLength(1);

    const consenting = [preference({ allowFallback: true, fallbacks: [fb] })];
    const ownerJob = resolverFor([shared, personal], consenting, {
      requestedBy: { type: "user", id: "u_owner" },
    });
    expect((await ownerJob.resolver.resolve(ctx(), { stage: "plan" })).bindings).toHaveLength(2);

    const otherJob = resolverFor([shared, personal], consenting, {
      requestedBy: { type: "user", id: "u_other" },
    });
    expect((await otherJob.resolver.resolve(ctx(), { stage: "plan" })).bindings).toHaveLength(1);
    expect(otherJob.released).not.toContain("pcon_p");
  });

  it("rejects ambient-auth providers, a provider mismatch and a snapshot for another stage", async () => {
    await expect(
      resolverFor(
        [{ ...shared, provider: "amazon-bedrock" }],
        [preference({ provider: "amazon-bedrock" })],
      ).resolver.resolve(ctx(), { stage: "plan" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      resolverFor([{ ...shared, provider: "openai" }], [preference()]).resolver.resolve(ctx(), {
        stage: "plan",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const first = await resolverFor([shared], [preference()]).resolver.resolve(ctx(), { stage: "plan" });
    await expect(
      resolverFor([shared], [], { snapshot: first.snapshot }).resolver.resolve(ctx(), { stage: "qa" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps the snapshot's connection and model on retry even if the preference changed", async () => {
    const first = await resolverFor([shared], [preference()]).resolver.resolve(ctx(), { stage: "plan" });
    const retry = await resolverFor([shared], [preference({ modelId: "different/model" })], {
      snapshot: first.snapshot,
    }).resolver.resolve(ctx(), { stage: "plan" });
    expect(retry.bindings[0]!.modelId).toBe("some/model");
    expect(retry.snapshot).toBe(first.snapshot);
  });
});

describe("Pi catalog", () => {
  it("lists API-key providers with models and offers no OAuth method", () => {
    const catalog = listPiCatalog();
    const anthropic = catalog.find((p) => p.id === "anthropic");
    expect(anthropic?.models.length).toBeGreaterThan(0);
    expect(anthropic?.authMethods).toEqual(["api_key"]);
    expect(anthropic?.oauthRestriction).toBeDefined();
    expect(catalog.find((p) => p.id === "amazon-bedrock")).toBeUndefined();
    expect(catalog.find((p) => p.id === "openrouter")?.models.length).toBeGreaterThan(0);
  });
});
