import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  type ClaudeMessage,
  type ClaudeQuery,
  type ClaudeQueryOptions,
  type ClaudeResultMessage,
  createClaudeAgentRuntime,
} from "../src/index.ts";

const KEY = "sk-ant-api03-secret-value-1234";

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "brand-intro",
  instructions: "Plan a 15s intro",
  input: { prompt: "coffee" },
  maxCostCents: 50,
  maxTurns: 4,
  ...overrides,
});

const success = (extra: Partial<ClaudeResultMessage> = {}): ClaudeResultMessage => ({
  type: "result",
  subtype: "success",
  result: "done",
  num_turns: 2,
  total_cost_usd: 0.031,
  usage: { input_tokens: 100, output_tokens: 40 },
  ...extra,
});

interface Harness {
  runtime: ReturnType<typeof createClaudeAgentRuntime>;
  options: () => ClaudeQueryOptions;
  closed: () => number;
  disposed: () => number;
  hardKills: () => number;
}

/** A scripted SDK query; `stream` decides what the iterator yields and how it reacts to close(). */
function harness(
  stream: (close: Promise<void>) => AsyncGenerator<ClaudeMessage>,
  opts: { killGraceMs?: number; closeEndsStream?: boolean; killWorks?: boolean } = {},
): Harness {
  let captured: ClaudeQueryOptions | undefined;
  let closes = 0;
  let disposes = 0;
  let kills = 0;
  const runtime = createClaudeAgentRuntime({
    model: "test-model",
    killGraceMs: opts.killGraceMs ?? 50,
    spawnProcess: () => {
      const child = {
        stdin: null,
        stdout: null,
        killed: false,
        exitCode: null as number | null,
        kill: () => {
          kills++;
          if (opts.killWorks !== false) child.killed = true;
          return true;
        },
        on: () => child,
        once: () => child,
        off: () => child,
      };
      return child as never;
    },
    resolveCredential: async () => ({ apiKey: KEY }),
    createSandbox: async () => ({
      dir: "/tmp/sandbox-test",
      dispose: async () => {
        disposes++;
      },
    }),
    query: ({ options }) => {
      captured = options;
      options.spawnClaudeCodeProcess?.({
        command: "claude",
        args: [],
        env: {},
        signal: options.abortController.signal,
      });
      let signalClose: () => void = () => {};
      const closePromise = new Promise<void>((resolve) => {
        signalClose = resolve;
      });
      const generator = stream(closePromise);
      const query: ClaudeQuery = {
        [Symbol.asyncIterator]: () => generator,
        close: () => {
          closes++;
          if (opts.closeEndsStream !== false) signalClose();
        },
      };
      return query;
    },
  });
  return {
    runtime,
    options: () => captured!,
    closed: () => closes,
    disposed: () => disposes,
    hardKills: () => kills,
  };
}

async function* scripted(...messages: ClaudeMessage[]): AsyncGenerator<ClaudeMessage> {
  for (const message of messages) yield message;
}

async function* untilClosed(close: Promise<void>): AsyncGenerator<ClaudeMessage> {
  await close;
  yield { type: "closed" };
}

describe("claude agent runtime", () => {
  it("maps a successful result and passes hard limits, no tools and a scoped env to the SDK", async () => {
    const h = harness(() => scripted({ type: "assistant" }, success({ structured_output: { scenes: 3 } })));
    const result = await h.runtime.run(testTenant(), task({ outputSchema: { type: "object" } }));
    expect(result).toEqual({
      output: { scenes: 3 },
      turns: 1,
      costCents: 4,
      inputTokens: 100,
      outputTokens: 40,
      model: "test-model",
    });
    const options = h.options();
    expect(options).toMatchObject({
      model: "test-model",
      maxTurns: 4,
      maxBudgetUsd: 0.5,
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
      cwd: "/tmp/sandbox-test",
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    });
    expect(Object.keys(options.env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "DISABLE_AUTOUPDATER",
      "HOME",
      "PATH",
      "TMPDIR",
    ]);
    expect(options.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(options.env.HOME).toBe("/tmp/sandbox-test");
    expect(options.tools).toEqual([]);
    expect(h.disposed()).toBe(1);
  });

  it("does not leak the credential into the prompt", async () => {
    let prompt = "";
    const runtime = createClaudeAgentRuntime({
      model: "m",
      resolveCredential: async () => ({ apiKey: KEY }),
      createSandbox: async () => ({ dir: "/tmp/x", dispose: async () => {} }),
      query: (params) => {
        prompt = params.prompt;
        return { [Symbol.asyncIterator]: () => scripted(success()), close() {} };
      },
    });
    await runtime.run(testTenant(), task());
    expect(prompt).not.toContain(KEY);
    expect(prompt).toContain('"prompt":"coffee"');
  });

  it("fails when the credential cannot be resolved and never starts the SDK", async () => {
    const query = vi.fn();
    const runtime = createClaudeAgentRuntime({
      model: "m",
      resolveCredential: async () => {
        throw Object.assign(new Error("no grant"), { name: "Error" });
      },
      query,
    });
    await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ message: "no grant" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["error_max_budget_usd", "BUDGET_EXCEEDED"],
    ["error_max_turns", "PROVIDER_ERROR"],
    ["error_max_structured_output_retries", "PROVIDER_ERROR"],
  ])("maps SDK result %s to %s", async (subtype, code) => {
    const h = harness(() => scripted(success({ subtype, is_error: true })));
    await expect(h.runtime.run(testTenant(), task())).rejects.toMatchObject({ code });
  });

  it.each([
    ["Invalid API key", "UNAUTHENTICATED"],
    ["API Error: 403 permission denied", "FORBIDDEN"],
    ["API Error: 429 rate limit", "RATE_LIMITED"],
    ["segfault", "PROVIDER_ERROR"],
  ])("maps failure text %j to %s and never marks it retryable", async (text, code) => {
    const h = harness(() => scripted(success({ subtype: "success", is_error: true, result: text })));
    const error = await h.runtime.run(testTenant(), task()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, retryable: false });
  });

  it("redacts the key from error messages", async () => {
    const h = harness(() => scripted(success({ is_error: true, result: `Invalid API key ${KEY}` })));
    const error = (await h.runtime.run(testTenant(), task()).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("[redacted]");
  });

  it("rejects results over the cost cap and missing structured output", async () => {
    const pricey = harness(() => scripted(success({ total_cost_usd: 0.51 })));
    await expect(pricey.runtime.run(testTenant(), task())).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    const bare = harness(() => scripted(success()));
    await expect(
      bare.runtime.run(testTenant(), task({ outputSchema: { type: "object" } })),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("rejects unpaid, tool-bearing and invalid tasks before starting anything", async () => {
    const h = harness(() => scripted(success()));
    await expect(h.runtime.run(testTenant(), task({ maxCostCents: 0 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      h.runtime.run(testTenant(), task({ tools: [{ name: "x", description: "x", inputSchema: {} }] })),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(h.runtime.run(testTenant(), task({ maxTurns: 0 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      h.runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() - 1) })),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(h.closed()).toBe(0);
  });

  it("stops the agent in-stream when it exceeds the turn limit", async () => {
    const h = harness(() =>
      scripted({ type: "assistant" }, { type: "assistant" }, { type: "assistant" }, success()),
    );
    await expect(h.runtime.run(testTenant(), task({ maxTurns: 2 }))).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(h.closed()).toBeGreaterThan(0);
  });

  it("closes the process on caller abort and returns only after it ended", async () => {
    const h = harness(untilClosed);
    const controller = new AbortController();
    const running = h.runtime.run(testTenant(), task({ signal: controller.signal }));
    await vi.waitFor(() => expect(h.options()).toBeDefined());
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.closed()).toBeGreaterThan(0);
    expect(h.options().abortController.signal.aborted).toBe(true);
    expect(h.disposed()).toBe(1);
    expect(h.hardKills()).toBe(0);
  });

  it("closes the process when the deadline passes", async () => {
    const h = harness(untilClosed);
    await expect(
      h.runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 30) })),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(h.closed()).toBeGreaterThan(0);
  });

  it("escalates to a hard kill when close() does not end the process", async () => {
    const h = harness(
      () =>
        (async function* () {
          await new Promise(() => {});
          yield { type: "never" };
        })(),
      { closeEndsStream: false, killGraceMs: 20 },
    );
    const controller = new AbortController();
    const running = h.runtime.run(testTenant(), task({ signal: controller.signal }));
    await vi.waitFor(() => expect(h.options()).toBeDefined());
    controller.abort();
    await expect(running).rejects.toMatchObject({
      code: "INTERNAL",
      retryable: false,
      details: { reason: "CANCELLED", processMayBeAlive: false },
    });
    expect(h.hardKills()).toBe(1);
    expect(h.disposed()).toBe(1);
  });

  it("keeps the sandbox when the process could not be confirmed dead", async () => {
    const h = harness(
      () =>
        (async function* () {
          await new Promise(() => {});
          yield { type: "never" };
        })(),
      { closeEndsStream: false, killGraceMs: 20, killWorks: false },
    );
    const controller = new AbortController();
    const running = h.runtime.run(testTenant(), task({ signal: controller.signal }));
    await vi.waitFor(() => expect(h.options()).toBeDefined());
    controller.abort();
    await expect(running).rejects.toMatchObject({
      code: "INTERNAL",
      details: { processMayBeAlive: true },
    });
    expect(h.hardKills()).toBe(1);
    expect(h.disposed()).toBe(0);
  });

  it("does not start the SDK when already aborted", async () => {
    const query = vi.fn();
    const runtime = createClaudeAgentRuntime({
      model: "m",
      resolveCredential: async () => ({ apiKey: KEY }),
      createSandbox: async () => ({ dir: "/tmp/x", dispose: async () => {} }),
      query,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.run(testTenant(), task({ signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("isolates tenants: each run resolves its own credential", async () => {
    const seen: string[] = [];
    const runtime = createClaudeAgentRuntime({
      model: "m",
      resolveCredential: async (ctx) => ({ apiKey: `sk-ant-for-${ctx.workspaceId}-xxxxxxxx` }),
      createSandbox: async () => ({ dir: "/tmp/x", dispose: async () => {} }),
      query: ({ options }) => {
        seen.push(options.env.ANTHROPIC_API_KEY!);
        return { [Symbol.asyncIterator]: () => scripted(success()), close() {} };
      },
    });
    await runtime.run(testTenant({ workspaceId: "wsp_a" }), task());
    await runtime.run(testTenant({ workspaceId: "wsp_b" }), task());
    expect(seen).toEqual(["sk-ant-for-wsp_a-xxxxxxxx", "sk-ant-for-wsp_b-xxxxxxxx"]);
  });
});

describe("claude agent runtime review fixes", () => {
  it("counts one turn per assistant message id, not per content block", async () => {
    const block = (id: string) => ({ type: "assistant", message: { id } });
    const h = harness(() =>
      scripted(block("m1"), block("m1"), block("m1"), block("m2"), success({ num_turns: 2 })),
    );
    await expect(h.runtime.run(testTenant(), task({ maxTurns: 2 }))).resolves.toMatchObject({
      turns: 2,
    });
    const over = harness(() => scripted(block("m1"), block("m2"), block("m3"), success()));
    await expect(over.runtime.run(testTenant(), task({ maxTurns: 2 }))).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it.each([
    ["API Error: 401 authentication_error", "UNAUTHENTICATED"],
    ["API Error: 403 permission_error", "FORBIDDEN"],
    ["API Error: 429 rate_limit_error", "RATE_LIMITED"],
    ["Your credit balance is too low to access the API", "FORBIDDEN"],
    ["API Error: 529 overloaded_error", "PROVIDER_ERROR"],
    ["upload URL expired", "PROVIDER_ERROR"],
    ["EACCES: permission denied, open '/tmp/x'", "PROVIDER_ERROR"],
    ["Permission to use Bash has been denied", "PROVIDER_ERROR"],
    ["quota of scenes exceeded", "PROVIDER_ERROR"],
  ])("classifies %j as %s", async (text, code) => {
    const h = harness(() => scripted(success({ is_error: true, result: text })));
    await expect(h.runtime.run(testTenant(), task())).rejects.toMatchObject({ code });
  });

  it("reports one turn for a single model call even when the SDK counts the structured-output round", async () => {
    const h = harness(() =>
      scripted(
        { type: "assistant", message: { id: "m1" } },
        success({ num_turns: 2, structured_output: { answer: "ok" } }),
      ),
    );
    await expect(
      h.runtime.run(testTenant(), task({ maxTurns: 1, outputSchema: { type: "object" } })),
    ).resolves.toMatchObject({ turns: 1, output: { answer: "ok" } });
  });

  it("keeps the spent cost on failures after the result arrived", async () => {
    const h = harness(() =>
      scripted(success({ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.52 })),
    );
    await expect(h.runtime.run(testTenant(), task())).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      details: { costCents: 52, turns: 2, inputTokens: 100, outputTokens: 40 },
    });
  });

  it("refuses a result without a cost instead of recording it as free", async () => {
    const h = harness(() => scripted({ ...success(), total_cost_usd: undefined as never }));
    await expect(h.runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("redacts the key from error details and drops the cause", async () => {
    const { StudixError } = await import("@studix/shared");
    const runtime = createClaudeAgentRuntime({
      model: "m",
      resolveCredential: async () => {
        throw new StudixError("FORBIDDEN", "no grant", { details: { token: KEY } });
      },
      query: vi.fn(),
    });
    const resolved = createClaudeAgentRuntime({
      model: "m",
      resolveCredential: async () => ({ apiKey: KEY }),
      createSandbox: async () => {
        throw new StudixError("INTERNAL", "boom", {
          details: { echoed: `key=${KEY}` },
          cause: new Error(KEY),
        });
      },
      query: vi.fn(),
    });
    await runtime.run(testTenant(), task()).catch(() => {});
    const error = (await resolved.run(testTenant(), task()).catch((e: unknown) => e)) as {
      details: unknown;
      cause?: unknown;
    };
    expect(JSON.stringify(error.details)).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });

  it("honours abort while the credential lookup hangs", async () => {
    const query = vi.fn();
    const runtime = createClaudeAgentRuntime({
      model: "m",
      resolveCredential: () => new Promise(() => {}),
      query,
    });
    await expect(
      runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 30) })),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(query).not.toHaveBeenCalled();
  });

  it("clamps far deadlines instead of firing immediately", async () => {
    const h = harness(() => scripted(success()));
    await expect(
      h.runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 40 * 86_400_000) })),
    ).resolves.toMatchObject({ turns: 2 });
  });
});

describe("claude sdk transport", () => {
  it("loads the pinned SDK lazily and exposes query", async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    expect(typeof sdk.query).toBe("function");
  });
});
