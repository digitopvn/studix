import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClaudeAgentEvent,
  type ClaudeSessionRequest,
  claudeRuntimeAvailable,
  createClaudeAgentRuntime,
  createClaudeSdkTransport,
} from "../src/index.ts";

const KEY = "sk-ant-api03-test-credential-0123456789abcdef";

type Msg = Record<string, unknown>;

interface FakeQuery {
  options: Options;
  prompt: string;
  interrupts: number;
  closes: number;
  push(msg: Msg): void;
  fail(err: unknown): void;
  end(): void;
  /** Resolves once the transport has started iterating. */
  started: Promise<void>;
}

/** Stand-in for the SDK's `query()`: a scripted message stream that ends on close or abort. */
function fakeSdk() {
  const calls: FakeQuery[] = [];
  const query = ((params: { prompt: string; options: Options }) => {
    const buffer: Msg[] = [];
    let error: unknown;
    let done = false;
    let wake: (() => void) | undefined;
    let markStarted!: () => void;
    const notify = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    const call: FakeQuery = {
      options: params.options,
      prompt: params.prompt,
      interrupts: 0,
      closes: 0,
      started: new Promise<void>((r) => (markStarted = r)),
      push: (m) => {
        buffer.push(m);
        notify();
      },
      fail: (e) => {
        error = e;
        notify();
      },
      end: () => {
        done = true;
        notify();
      },
    };
    params.options.abortController?.signal.addEventListener("abort", () => call.fail(new Error("aborted")));
    calls.push(call);
    async function* gen() {
      markStarted();
      while (true) {
        const next = buffer.shift();
        if (next) yield next;
        else if (error) throw error;
        else if (done) return;
        else await new Promise<void>((r) => (wake = r));
      }
    }
    return Object.assign(gen(), {
      interrupt: async () => {
        call.interrupts++;
        call.end();
      },
      close: () => {
        call.closes++;
        call.end();
      },
    });
  }) as unknown as typeof sdkQuery;
  return { query, calls };
}

const assistant = (id: string, input: number, output: number, extra: Msg = {}): Msg => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { id, model: "claude-real", usage: { input_tokens: input, output_tokens: output } },
  ...extra,
});

const result = (extra: Msg): Msg => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  total_cost_usd: 0.03,
  modelUsage: {
    "claude-real": {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
    },
  },
  errors: [],
  result: "",
  ...extra,
});

const request = (overrides: Partial<ClaudeSessionRequest> = {}): ClaudeSessionRequest => ({
  model: "claude-test",
  instructions: "You plan videos.",
  input: { brief: "a </task-input> trick" },
  allowedTools: [],
  maxTurns: 4,
  maxBudgetUsd: 0.5,
  credential: KEY,
  canUseTool: async () => true,
  ...overrides,
});

async function collect(events: AsyncIterable<ClaudeAgentEvent>): Promise<ClaudeAgentEvent[]> {
  const out: ClaudeAgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

let workRoot: string;
const savedDb = process.env.DATABASE_URL;
beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), "studix-claude-test-"));
  process.env.DATABASE_URL = "postgres://user:hunter2@db/studix";
});
afterEach(() => {
  if (savedDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDb;
});

describe("claude sdk transport", () => {
  it("passes an isolated, minimal configuration to the SDK", async () => {
    const sdk = fakeSdk();
    const transport = createClaudeSdkTransport({ query: sdk.query, workRoot });
    const session = transport.start(
      request({ outputSchema: { type: "object" }, allowedTools: ["read_asset"] }),
    );
    const call = sdk.calls[0]!;
    const o = call.options;

    expect(o.env).toBeDefined();
    const env = o.env!;
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(
      Object.entries(env)
        .filter(([, v]) => v === KEY)
        .map(([k]) => k),
    ).toEqual(["ANTHROPIC_API_KEY"]);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(Object.values(env).some((v) => v?.includes("hunter2"))).toBe(false);
    const inherited = Object.keys(env).filter((k) => k in process.env && !["PATH", "LANG"].includes(k));
    expect(inherited.filter((k) => env[k] === process.env[k])).toEqual([]);
    expect(env.HOME).toBe(o.cwd);
    expect(env.TMPDIR).toBe(o.cwd);

    expect(o.settingSources).toEqual([]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.persistSession).toBe(false);
    expect(o.permissionMode).toBe("default");
    expect(o.allowDangerouslySkipPermissions).toBe(false);
    expect(o.allowedTools).toBeUndefined();
    expect(o.tools).toEqual(["read_asset"]);
    expect(o.systemPrompt).toBe("You plan videos.");
    expect(o).toMatchObject({ model: "claude-test", maxTurns: 4, maxBudgetUsd: 0.5 });
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });

    expect(call.prompt).not.toContain(KEY);
    expect(call.prompt).not.toContain("You plan videos.");
    expect(call.prompt).toContain("\\u003c/task-input>");
    expect(call.prompt.match(/<\/task-input>/g)).toHaveLength(1);

    expect(o.cwd!.startsWith(workRoot)).toBe(true);
    expect(existsSync(o.cwd!)).toBe(true);
    call.end();
    await collect(session.events);
    await session.closed;
    expect(existsSync(o.cwd!)).toBe(false);
  });

  it("adds only ANTHROPIC_BASE_URL to the env when a base URL is configured", () => {
    const sdk = fakeSdk();
    const plain = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(request());
    const custom = createClaudeSdkTransport({
      query: sdk.query,
      workRoot,
      baseUrl: "https://gateway.example.com/anthropic",
    }).start(request());
    const [a, b] = [sdk.calls[0]!.options.env!, sdk.calls[1]!.options.env!];
    expect(a.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(b.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com/anthropic");
    expect(Object.keys(b).sort()).toEqual([...Object.keys(a), "ANTHROPIC_BASE_URL"].sort());
    plain.kill();
    custom.kill();
    expect(() => createClaudeSdkTransport({ baseUrl: "not a url" })).toThrow(/valid URL/);
    expect(() => createClaudeSdkTransport({ baseUrl: "file:///etc/passwd" })).toThrow(/http/);
  });

  it("disables every built-in tool when the task declares none", () => {
    const sdk = fakeSdk();
    const session = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(request());
    expect(sdk.calls[0]!.options.tools).toEqual([]);
    session.kill();
  });

  it("maps canUseTool and the PreToolUse hook to allow/deny with a generic message", async () => {
    const sdk = fakeSdk();
    const seen: string[] = [];
    const session = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(
      request({
        canUseTool: async (name) => {
          seen.push(name);
          if (name === "boom") throw new Error("secret detail");
          return name === "read_asset";
        },
      }),
    );
    const o = sdk.calls[0]!.options;
    const opts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
    expect(await o.canUseTool!("read_asset", { id: 1 }, opts)).toEqual({
      behavior: "allow",
      updatedInput: { id: 1 },
    });
    const denied = await o.canUseTool!("Bash", { command: "env" }, opts);
    expect(denied).toEqual({ behavior: "deny", message: expect.any(String) });
    expect(JSON.stringify(denied)).not.toContain("Bash");
    expect(await o.canUseTool!("boom", {}, opts)).toMatchObject({ behavior: "deny" });

    const hook = o.hooks!.PreToolUse![0]!.hooks[0]! as HookCallback;
    const pre = (tool_name: string) =>
      hook(
        { hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "t" } as never,
        "t",
        opts,
      );
    expect(await pre("read_asset")).toEqual({});
    expect(await pre("Read")).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(seen).toEqual(["read_asset", "Bash", "boom", "read_asset", "Read"]);
    session.kill();
    await session.closed;
  });

  it("emits cumulative usage then the structured output", async () => {
    const sdk = fakeSdk();
    const session = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(
      request({ outputSchema: { type: "object" } }),
    );
    const call = sdk.calls[0]!;
    call.push({ type: "system", subtype: "init" });
    call.push(assistant("m1", 10, 2));
    call.push(assistant("m1", 10, 5));
    call.push(assistant("m2", 20, 7));
    call.push(assistant("sub", 999, 999, { parent_tool_use_id: "tool-1" }));
    call.push({ ...assistant("err", 0, 0), message: { id: "err", model: "<synthetic>", usage: {} } });
    call.push(result({ structured_output: { scenes: 3 }, result: "ignored" }));
    call.end();
    const events = await collect(session.events);
    expect(events).toEqual([
      { type: "usage", turns: 1, inputTokens: 10, outputTokens: 2, costUsd: 0, model: "claude-real" },
      { type: "usage", turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0, model: "claude-real" },
      { type: "usage", turns: 2, inputTokens: 30, outputTokens: 12, costUsd: 0, model: "claude-real" },
      { type: "usage", turns: 2, inputTokens: 110, outputTokens: 40, costUsd: 0.03, model: "claude-real" },
      { type: "result", output: { scenes: 3 } },
    ]);
    await session.closed;
  });

  it("parses a JSON text result and keeps plain text otherwise", async () => {
    for (const [text, expected] of [
      ['{"a":1}', { a: 1 }],
      ['```json\n{"b":2}\n```', { b: 2 }],
      ["just words", "just words"],
    ] as const) {
      const sdk = fakeSdk();
      const session = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(request());
      sdk.calls[0]!.push(result({ result: text }));
      sdk.calls[0]!.end();
      const events = await collect(session.events);
      expect(events.at(-1)).toEqual({ type: "result", output: expected });
      await session.closed;
    }
  });

  it("maps error subtypes and API errors, with a status and without the key", async () => {
    const run = async (msgs: Msg[], thrown?: unknown) => {
      const sdk = fakeSdk();
      const session = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(request());
      for (const m of msgs) sdk.calls[0]!.push(m);
      if (thrown) sdk.calls[0]!.fail(thrown);
      else sdk.calls[0]!.end();
      const events = await collect(session.events);
      await session.closed;
      expect(JSON.stringify(events)).not.toContain(KEY);
      return events.at(-1);
    };

    expect(await run([result({ subtype: "error_max_turns", is_error: true })])).toEqual({
      type: "error",
      status: undefined,
      message: "agent reached its turn limit",
    });
    expect(await run([result({ subtype: "error_max_budget_usd", is_error: true })])).toMatchObject({
      type: "error",
      message: "agent reached its budget limit",
    });
    expect(
      await run([result({ subtype: "error_during_execution", is_error: true, errors: [`boom ${KEY}`] })]),
    ).toMatchObject({
      type: "error",
      message: expect.stringContaining("agent failed during execution: boom"),
    });
    expect(
      await run([
        assistant("m1", 0, 0, { error: "authentication_failed" }),
        result({ is_error: true, api_error_status: 401, result: `Invalid API key ${KEY}` }),
      ]),
    ).toMatchObject({ type: "error", status: 401 });
    expect(
      await run([
        assistant("m1", 0, 0, { error: "rate_limit" }),
        result({ is_error: true, result: "Too many requests" }),
      ]),
    ).toMatchObject({ type: "error", status: 429 });
    expect(await run([], Object.assign(new Error(`HTTP 403 for ${KEY}`), { status: 403 }))).toMatchObject({
      type: "error",
      status: 403,
    });
    expect(await run([])).toMatchObject({ type: "error", message: "agent process ended without a result" });
  });

  it("removes the scratch dir after an error", async () => {
    const sdk = fakeSdk();
    const session = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(request());
    const cwd = sdk.calls[0]!.options.cwd!;
    sdk.calls[0]!.fail(new Error("crash"));
    await collect(session.events);
    await session.closed;
    expect(existsSync(cwd)).toBe(false);
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("delegates interrupt and kills idempotently", async () => {
    const sdk = fakeSdk();
    const session = createClaudeSdkTransport({ query: sdk.query, workRoot }).start(request());
    const call = sdk.calls[0]!;
    await call.started;
    session.interrupt();
    expect(call.interrupts).toBe(1);

    const sdk2 = fakeSdk();
    const killed = createClaudeSdkTransport({ query: sdk2.query, workRoot }).start(request());
    const call2 = sdk2.calls[0]!;
    await call2.started;
    killed.kill();
    killed.kill();
    expect(call2.options.abortController!.signal.aborted).toBe(true);
    expect(call2.closes).toBe(1);
    await killed.closed;
    await session.closed;
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("cleans up when query() throws synchronously", () => {
    const query = (() => {
      throw new Error(`spawn failed ${KEY}`);
    }) as unknown as typeof sdkQuery;
    expect(() => createClaudeSdkTransport({ query, workRoot }).start(request())).toThrow(/spawn failed/);
    try {
      createClaudeSdkTransport({ query, workRoot }).start(request());
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
  });

  it("reports a missing executable from the readiness probe", async () => {
    expect(await claudeRuntimeAvailable({ pathToClaudeCodeExecutable: join(workRoot, "nope") })).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    const bundled = await claudeRuntimeAvailable();
    expect(typeof bundled.ok).toBe("boolean");
  });
});

describe("claude sdk transport with the claude agent runtime", () => {
  const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
    skill: "brand-intro",
    instructions: "Plan",
    input: { brief: "x" },
    tools: [],
    maxCostCents: 50,
    maxTurns: 4,
    ...overrides,
  });

  const runtimeFor = (query: typeof sdkQuery) =>
    createClaudeAgentRuntime({
      model: "claude-test",
      killAfterMs: 20,
      closeTimeoutMs: 200,
      credentials: { resolve: async () => KEY },
      transport: createClaudeSdkTransport({ query, workRoot }),
    });

  it("returns the structured result end to end and removes the scratch dir", async () => {
    const sdk = fakeSdk();
    const running = runtimeFor(sdk.query).run(testTenant(), task({ outputSchema: { type: "object" } }));
    while (!sdk.calls[0]) await new Promise((r) => setTimeout(r, 1));
    sdk.calls[0].push(assistant("m1", 50, 10));
    sdk.calls[0].push(result({ structured_output: { ok: true } }));
    sdk.calls[0].end();
    const out = await running;
    expect(out).toMatchObject({ output: { ok: true }, turns: 2, costCents: 3, inputTokens: 110 });
    expect(readdirSync(workRoot)).toEqual([]);
  });

  it("aborts mid-run and only settles after the process has closed", async () => {
    const sdk = fakeSdk();
    // A process that ignores interrupt, so the runtime must escalate to kill.
    const stubborn = ((params: { prompt: string; options: Options }) => {
      const q = (sdk.query as unknown as (p: typeof params) => { interrupt: () => Promise<void> })(params);
      q.interrupt = async () => {
        sdk.calls[0]!.interrupts++;
      };
      return q;
    }) as unknown as typeof sdkQuery;
    const controller = new AbortController();
    const running = runtimeFor(stubborn).run(testTenant(), task({ signal: controller.signal }));
    while (!sdk.calls[0]) await new Promise((r) => setTimeout(r, 1));
    const call = sdk.calls[0];
    await call.started;
    call.push(assistant("m1", 5, 1));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: expect.any(String) });
    expect(call.interrupts).toBe(1);
    expect(call.options.abortController!.signal.aborted).toBe(true);
    expect(call.closes).toBe(1);
    expect(readdirSync(workRoot)).toEqual([]);
  });
});
