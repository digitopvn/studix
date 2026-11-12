import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StudixError } from "@studix/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ClaudeAgentTransport,
  type ClaudeSessionRequest,
  type ClaudeSpawnOptions,
  createClaudeCodeCliTransport,
  createClaudeRoutingTransport,
  createClaudeSdkTransport,
} from "../src/index.ts";

const TOKEN = "sk-ant-oat01-subscriptiontokenforthetest-ZZZZ";

const request = (overrides: Partial<ClaudeSessionRequest> = {}): ClaudeSessionRequest => ({
  model: "claude-sonnet-5-5",
  instructions: "Plan it.",
  input: { brief: "coffee" },
  allowedTools: [],
  outputSchema: { type: "object", properties: { answer: { type: "string" } } },
  maxTurns: 2,
  maxBudgetUsd: 1,
  credential: TOKEN,
  credentialKind: "subscription",
  canUseTool: async () => false,
  ...overrides,
});

/** A child process stand-in that prints `lines` on stdout once stdin ends, then exits 0. */
function fakeClaudeCode(lines: unknown[], seen: ClaudeSpawnOptions[], stdin: string[]) {
  return (options: ClaudeSpawnOptions) => {
    seen.push(options);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const input = new PassThrough();
    const output = new PassThrough();
    let chunks = "";
    input.on("data", (c) => {
      chunks += String(c);
    });
    input.on("end", () => {
      stdin.push(chunks);
      for (const line of lines) output.write(`${JSON.stringify(line)}\n`);
      output.end();
      child.exitCode = 0;
      setImmediate(() => child.emit("exit", 0));
    });
    Object.assign(child, { stdin: input, stdout: output, killed: false, exitCode: null, signalCode: null });
    child.kill = () => true;
    return child as never;
  };
}

async function drain(transport: ClaudeAgentTransport, req: ClaudeSessionRequest) {
  const session = transport.start(req);
  const events = [];
  for await (const event of session.events) events.push(event);
  await session.closed;
  return events;
}

describe("Claude Code CLI transport (subscriptions)", () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "studix-cli-"));
  afterAll(() => rmSync(sandboxRoot, { recursive: true, force: true }));

  it("runs the given executable directly with the token only in CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const seen: ClaudeSpawnOptions[] = [];
    const stdin: string[] = [];
    const transport = createClaudeCodeCliTransport({
      executable: "/opt/claude/bin/claude",
      sandboxRoot,
      spawnProcess: fakeClaudeCode(
        [
          { type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 5 } } },
          {
            type: "result",
            subtype: "success",
            structured_output: { answer: "ok" },
            total_cost_usd: 0.01,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        ],
        seen,
        stdin,
      ),
    });
    const events = await drain(transport, request());
    expect(events.at(-1)).toEqual({ type: "result", output: { answer: "ok" } });
    expect(seen).toHaveLength(1);
    const [spawned] = seen;
    expect(spawned?.command).toBe("/opt/claude/bin/claude");
    expect(spawned?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(spawned?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spawned?.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(spawned?.args.join(" ")).not.toContain(TOKEN);
    expect(spawned?.args).toEqual(
      expect.arrayContaining(["--print", "--no-session-persistence", "--json-schema", "--tools"]),
    );
    expect(stdin[0]).toContain("coffee");
    expect(stdin[0]).not.toContain(TOKEN);
  });

  it("refuses an API key, and the SDK transport refuses a subscription", () => {
    const cli = createClaudeCodeCliTransport({ executable: "/bin/false", sandboxRoot });
    expect(() => cli.start(request({ credentialKind: "api_key" }))).toThrow(StudixError);
    const images = [{ mimeType: "image/png" as const, data: "iVBORw0KGgo=" }];
    expect(() => cli.start(request({ credentialKind: "subscription", images }))).toThrow(
      /cannot send images/,
    );
    const sdk = createClaudeSdkTransport({ sandboxRoot, query: () => [] as never });
    expect(() => sdk.start(request())).toThrow(/never passed to the Claude Agent SDK/);
  });

  it("routes by credential kind and refuses subscriptions without a CLI transport", () => {
    const used: string[] = [];
    const stub = (name: string): ClaudeAgentTransport => ({
      start() {
        used.push(name);
        return {} as never;
      },
    });
    const routed = createClaudeRoutingTransport({ apiKey: stub("sdk"), subscription: stub("cli") });
    routed.start(request({ credentialKind: "api_key" }));
    routed.start(request());
    expect(used).toEqual(["sdk", "cli"]);
    const apiOnly = createClaudeRoutingTransport({ apiKey: stub("sdk") });
    expect(() => apiOnly.start(request())).toThrow(/does not run Claude subscriptions/);
  });
});
