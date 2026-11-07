import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  claudeCodeCliArgs,
  claudeEffortOf,
  claudeStreamUsageOf,
  createClaudeCodeSandboxRuntime,
  type PiTaskWorkspace,
  type PiTaskWorkspaceProvider,
  type SandboxSession,
} from "../src/index.ts";

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "skill-agent.run",
  instructions: "Make the video",
  input: {},
  tools: [{ name: "bash", description: "bash", inputSchema: {} }],
  maxCostCents: 800,
  maxTurns: 150,
  ...overrides,
});

const assistant = (input: number, output: number) =>
  JSON.stringify({ type: "assistant", message: { usage: { input_tokens: input, output_tokens: output } } });
const result = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    total_cost_usd: 0.123,
    usage: { input_tokens: 30, output_tokens: 7 },
    structured_output: { video: "out/video.mp4", summary: "done" },
    ...over,
  });

/** A sandbox whose `claude --print` prints the given stream-json lines, keeping files written through stdin. */
function fakeWorkspace(stream: string[], exitCode = 0) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const state = { closed: false };
  const sandbox = {
    id: "studix-sbx-test",
    async exec(command: string, opts: { onData?(chunk: Buffer): void } = {}) {
      commands.push(command);
      opts.onData?.(Buffer.from(`${stream.join("\n")}\n`));
      return { exitCode };
    },
    async run(argv: readonly string[], opts: { stdin?: string } = {}) {
      const script = argv[2] ?? "";
      commands.push(script);
      const target = /cat > (\S+)/.exec(script)?.[1];
      if (target) files.set(target, String(opts.stdin ?? ""));
      return Buffer.alloc(0);
    },
  } as unknown as SandboxSession;
  const workspace = {
    sandbox,
    skills: [],
    async collect() {
      return ["/host/out/video.mp4"];
    },
    async close() {
      state.closed = true;
    },
  } as unknown as PiTaskWorkspace;
  const provider = { open: async () => workspace } as unknown as PiTaskWorkspaceProvider;
  return { provider, files, commands, state };
}

describe("claude effort", () => {
  it("maps job efforts to Claude Code levels and passes them on the command line", () => {
    expect(claudeEffortOf(undefined)).toBeUndefined();
    expect(claudeEffortOf("off")).toBeUndefined();
    expect(claudeEffortOf("minimal")).toBe("low");
    expect(claudeEffortOf("xhigh")).toBe("xhigh");
    const args = claudeCodeCliArgs({
      model: "claude-test",
      maxTurns: 3,
      maxBudgetUsd: 1,
      effort: "high",
      systemPrompt: "s",
      tools: [],
      permissionMode: "dontAsk",
    } as unknown as Parameters<typeof claudeCodeCliArgs>[0]);
    expect(args.join(" ")).toContain("--effort high");
  });
});

describe("claude code sandbox runtime", () => {
  it("prefers the result event's totals", () => {
    expect(claudeStreamUsageOf([assistant(10, 2), "noise", result()]).usage).toEqual({
      turns: 2,
      inputTokens: 30,
      outputTokens: 7,
      costUsd: 0.123,
    });
  });

  // Shape of a recorded stream-json run: Claude Code prints one assistant line per content block, each repeating the
  // message id and usage, then a user line with the tool result, then the final result.
  const recorded = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
    ...["thinking", "text", "tool_use"].map((type) =>
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_1",
          content: [
            type === "tool_use"
              ? { type, id: "toolu_1", name: "Bash", input: { command: "ls" } }
              : { type, [type]: "x" },
          ],
          usage: { input_tokens: 4, cache_read_input_tokens: 9000, output_tokens: 120 },
        },
      }),
    ),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "index.html" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_2",
        content: [{ type: "text", text: "Done" }],
        usage: { input_tokens: 2, output_tokens: 30 },
      },
    }),
    result({ num_turns: 2, total_cost_usd: 5.1666, usage: { input_tokens: 6, output_tokens: 150 } }),
  ];

  it("counts a recorded stream's turns by message id and books the final result's usage and cost", async () => {
    expect(claudeStreamUsageOf(recorded.slice(0, -1)).usage).toEqual({
      turns: 2,
      inputTokens: 6,
      outputTokens: 150,
      costUsd: 0,
    });
    const ws = fakeWorkspace(recorded);
    const runtime = createClaudeCodeSandboxRuntime({
      workspace: ws.provider,
      model: "claude-opus-5-5",
      credential: async () => ({ secret: "sk-ant-api03-test-key-not-real-0002", kind: "api_key" }),
    });
    const out = await runtime.run(testTenant(), task({ maxTurns: 2 }));
    expect(out).toMatchObject({ turns: 2, inputTokens: 6, outputTokens: 150, costCents: 517 });
  });

  it("runs claude --print with model, caps and effort, keeps the key off the command line and attaches files", async () => {
    const apiKey = "sk-ant-api03-test-key-not-real-0001";
    const ws = fakeWorkspace([assistant(10, 2), result()]);
    const runtime = createClaudeCodeSandboxRuntime({
      workspace: ws.provider,
      model: "claude-opus-5-5",
      reasoningEffort: "xhigh",
      credential: async () => ({ secret: apiKey, kind: "api_key" }),
    });
    const out = await runtime.run(
      testTenant(),
      task({ outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } }),
    );
    // Claude Code rejects the 2020-12 meta-schema and exits before the first call.
    expect(ws.files.get("/work/.task/schema.json")).toBe('{"type":"object"}');
    expect(out).toMatchObject({
      output: { video: "out/video.mp4", files: ["/host/out/video.mp4"] },
      turns: 2,
      costCents: 13,
      model: "claude-opus-5-5",
    });
    const exec = ws.commands.find((c) => c.includes("claude --print"))!;
    expect(exec).toContain("--model claude-opus-5-5");
    expect(exec).toContain("--max-turns 150");
    expect(exec).toContain("--effort xhigh");
    expect(exec).toContain("ANTHROPIC_API_KEY=");
    expect(ws.commands.join("\n")).not.toContain(apiKey);
    expect(ws.files.get("/work/.task/credential")).toBe(apiKey);
    expect(ws.state.closed).toBe(true);
  });

  it("bills a subscription at 0 and maps a 401 result to UNAUTHENTICATED without the token", async () => {
    const token = "sk-ant-oat01-test-token-not-real-0002";
    const ws = fakeWorkspace(
      [result({ subtype: "error", is_error: true, result: `401 bad token ${token}` })],
      1,
    );
    const runtime = createClaudeCodeSandboxRuntime({
      workspace: ws.provider,
      model: "claude-opus-5-5",
      credential: async () => ({ secret: token, kind: "subscription" }),
    });
    const error = await runtime.run(testTenant(), task()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudixError);
    expect((error as StudixError).code).toBe("UNAUTHENTICATED");
    expect(JSON.stringify((error as StudixError).toJSON())).not.toContain(token);
    expect(ws.commands.find((c) => c.includes("claude --print"))).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(ws.state.closed).toBe(true);
  });
});
