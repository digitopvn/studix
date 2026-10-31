import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentTask,
  ModelPreference,
  ProviderConnection,
  ResolvedModelSnapshot,
  TenantContext,
} from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPiSdkAgentRuntime,
  createProviderBindingResolver,
  listPiCatalog,
  type PiBindingResolver,
  type PiRunBinding,
} from "../src/index.ts";

interface Seen {
  auth: string | undefined;
  body: { model?: string };
}

let server: Server;
let baseUrl = "";
const seen: Seen[] = [];
let respond: (seen: Seen) => { status: number; text?: string; costPerMTok?: number } = () => ({
  status: 200,
  text: '{"ok":true}',
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

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
    const chunk = (delta: object, extra: object = {}) =>
      res.write(
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", ...extra, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
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
  connectionId: "pconn_1",
  endpoint: {
    baseUrl,
    api: "openai-completions",
    // $1 per million input tokens, so the fake server's 1M prompt tokens cost 100 cents.
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
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer runtime-key-0123456789");
    expect(seen[0]!.body.model).toBe("acme-1");
    expect(existsSync(join(homedir(), ".pi", "agent", "auth.json"))).toBe(false);
  });

  it("stops on the cost cap while the run is in flight", async () => {
    respond = () => ({ status: 200, text: "x" });
    const runtime = createPiSdkAgentRuntime({ resolver: staticResolver(binding()) });
    await expect(runtime.run(testTenant(), task({ maxCostCents: 10 }))).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("maps a rejected credential to UNAUTHENTICATED and never falls back on its own", async () => {
    seen.length = 0;
    respond = () => ({ status: 401 });
    const runtime = createPiSdkAgentRuntime({
      resolver: staticResolver(
        binding(),
        binding({ connectionId: "pconn_2", apiKey: "other-key-0123456789" }),
      ),
    });
    await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });

  it("tries the next explicit binding only after a provider failure", async () => {
    seen.length = 0;
    respond = (s) => (s.auth?.includes("bad-key") ? { status: 500 } : { status: 200, text: '{"ok":1}' });
    const runtime = createPiSdkAgentRuntime({
      resolver: staticResolver(
        binding({ apiKey: "bad-key-0123456789" }),
        binding({ apiKey: "good-key-0123456789" }),
      ),
    });
    const result = await runtime.run(testTenant(), task({ outputSchema: { type: "object" } }));
    expect(result.output).toEqual({ ok: 1 });
    expect(seen.map((s) => s.auth)).toContain("Bearer good-key-0123456789");
  });

  it("cancels on abort and rejects tools", async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = createPiSdkAgentRuntime({ resolver: staticResolver(binding()) });
    await expect(runtime.run(testTenant(), task({ signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(
      runtime.run(
        testTenant(),
        task({ tools: [{ name: "shell", description: "x", inputSchema: {} }] as never }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

const ctxOf = (_userId: string): TenantContext => ({
  ...testTenant(),
  actor: { type: "system", id: "worker" },
});

const connection = (over: Partial<ProviderConnection> = {}): ProviderConnection => ({
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
  ...over,
});

const preference = (over: Partial<ModelPreference> = {}): ModelPreference => ({
  id: "mpref_1",
  organizationId: "org",
  workspaceId: "ws",
  scope: { type: "workspace" },
  stage: "default",
  runtime: "pi",
  connectionId: "pconn_1",
  provider: "openrouter",
  modelId: "some/model",
  allowFallback: false,
  fallbacks: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

function resolverFor(
  conns: ProviderConnection[],
  prefs: ModelPreference[],
  extra: { requestedBy?: { type: "user"; id: string }; snapshot?: ResolvedModelSnapshot } = {},
) {
  const reveals: string[] = [];
  const resolver = createProviderBindingResolver({
    connections: {
      async get(lookup, id) {
        const userId = lookup.actor.type === "user" ? lookup.actor.id : undefined;
        return conns.find((c) => c.id === id && (c.owner.type === "workspace" || c.owner.userId === userId));
      },
    },
    preferences: {
      async list() {
        return prefs;
      },
    },
    vault: {
      async reveal(_ctx, ref) {
        reveals.push(ref);
        return `secret-for-${ref}-0123456789`;
      },
    },
    ...extra,
  });
  return { resolver, reveals };
}

describe("provider binding resolver", () => {
  it("binds the preferred connection and snapshots the choice", async () => {
    const { resolver, reveals } = resolverFor([connection()], [preference()]);
    const run = await resolver.resolve(ctxOf(""), { stage: "plan" });
    expect(run.bindings).toHaveLength(1);
    expect(run.bindings[0]).toMatchObject({
      provider: "openrouter",
      modelId: "some/model",
      connectionId: "pconn_1",
    });
    expect(run.snapshot).toMatchObject({ source: "workspace-default", connectionVersion: 1 });
    expect(reveals).toEqual(["cred_1"]);
  });

  it("fails clearly when no model is chosen or the connection is unusable", async () => {
    await expect(
      resolverFor([connection()], []).resolver.resolve(ctxOf(""), { stage: "plan" }),
    ).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    await expect(
      resolverFor([connection({ status: "expired" })], [preference()]).resolver.resolve(ctxOf(""), {
        stage: "plan",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      resolverFor([connection({ runtimes: ["claude-agent-sdk"] })], [preference()]).resolver.resolve(
        ctxOf(""),
        {
          stage: "plan",
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("uses fallbacks only with consent and never reveals a personal secret to another user's job", async () => {
    const personal = connection({
      id: "pconn_p",
      owner: { type: "user", userId: "u_owner" },
      secretRef: "cred_p",
    });
    const fb = { connectionId: "pconn_p", provider: "openrouter", modelId: "other/model" };
    const withoutConsent = resolverFor([connection(), personal], [preference({ fallbacks: [fb] })]);
    expect((await withoutConsent.resolver.resolve(ctxOf(""), { stage: "plan" })).bindings).toHaveLength(1);

    const ownerJob = resolverFor(
      [connection(), personal],
      [preference({ allowFallback: true, fallbacks: [fb] })],
      {
        requestedBy: { type: "user", id: "u_owner" },
      },
    );
    expect((await ownerJob.resolver.resolve(ctxOf(""), { stage: "plan" })).bindings).toHaveLength(2);

    const otherJob = resolverFor(
      [connection(), personal],
      [preference({ allowFallback: true, fallbacks: [fb] })],
      {
        requestedBy: { type: "user", id: "u_other" },
      },
    );
    await expect(otherJob.resolver.resolve(ctxOf(""), { stage: "plan" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(otherJob.reveals).not.toContain("cred_p");
  });

  it("keeps the snapshot's connection and model on retry even if the preference changed", async () => {
    const first = await resolverFor([connection()], [preference()]).resolver.resolve(ctxOf(""), {
      stage: "plan",
    });
    const changed = preference({ modelId: "different/model" });
    const retry = await resolverFor([connection()], [changed], { snapshot: first.snapshot }).resolver.resolve(
      ctxOf(""),
      { stage: "plan" },
    );
    expect(retry.bindings[0]!.modelId).toBe("some/model");
  });
});

describe("Pi catalog", () => {
  it("lists providers with models and keeps restricted OAuth out of the offered methods", () => {
    const catalog = listPiCatalog();
    const anthropic = catalog.find((p) => p.id === "anthropic");
    expect(anthropic?.models.length).toBeGreaterThan(0);
    expect(anthropic?.authMethods).toEqual(["api_key"]);
    expect(anthropic?.oauthRestriction).toBeDefined();
    expect(catalog.find((p) => p.id === "openrouter")?.authMethods).toContain("api_key");
  });
});
