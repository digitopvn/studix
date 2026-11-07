import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  codexUsageOf,
  createCodexAgentRuntime,
  type PiTaskWorkspace,
  type PiTaskWorkspaceProvider,
  type SandboxSession,
} from "../src/index.ts";

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "brand-intro",
  instructions: "Plan",
  input: {},
  tools: [],
  maxCostCents: 50,
  maxTurns: 4,
  ...overrides,
});

const turn = (input: number, output: number) =>
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, output_tokens: output } });

/** A sandbox whose `codex exec` prints the given JSONL lines, keeping files written through stdin. */
function fakeWorkspace(stream: string[], exitCode = 0, rotate?: string) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const state = { closed: false };
  const sandbox = {
    id: "studix-sbx-test",
    async exec(command: string, opts: { onData?(chunk: Buffer): void } = {}) {
      commands.push(command);
      opts.onData?.(Buffer.from(`${stream.join("\n")}\n`));
      files.set("/work/.task/last.txt", '{"ok":true}');
      if (rotate) files.set("/work/.codex/auth.json", rotate);
      return { exitCode };
    },
    async run(argv: readonly string[], opts: { stdin?: string } = {}) {
      const [cmd, ...rest] = argv;
      if (cmd === "cat") {
        const body = files.get(rest[0]!);
        if (body === undefined) throw new Error("No such file");
        return Buffer.from(body);
      }
      const script = rest[1] ?? "";
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
      return [];
    },
    async close() {
      state.closed = true;
    },
  } as unknown as PiTaskWorkspace;
  const provider: PiTaskWorkspaceProvider = { open: async () => workspace } as PiTaskWorkspaceProvider;
  return { provider, files, commands, state };
}

describe("codex agent runtime", () => {
  it("sums usage from turn.completed events only", () => {
    expect(codexUsageOf([turn(10, 2), "noise", '{"type":"item.completed"}', turn(5, 1)])).toEqual({
      turns: 2,
      inputTokens: 15,
      outputTokens: 3,
    });
  });

  it("runs codex exec with the model and effort, parses the schema output and keeps a rotated login", async () => {
    const stored: string[] = [];
    const ws = fakeWorkspace([turn(100, 20)], 0, '{"tokens":"rotated"}');
    const runtime = createCodexAgentRuntime({
      workspace: ws.provider,
      model: "gpt-5.5",
      reasoningEffort: "high",
      credential: async () => ({
        kind: "chatgpt",
        authJson: '{"tokens":"first"}',
        storeRefreshed: async (json) => {
          stored.push(json);
        },
      }),
    });
    const result = await runtime.run(testTenant(), task({ outputSchema: { type: "object" } }));
    expect(result).toMatchObject({
      output: { ok: true },
      turns: 1,
      inputTokens: 100,
      costCents: 0,
      model: "gpt-5.5",
    });
    const exec = ws.commands.find((c) => c.includes("codex exec"))!;
    expect(exec).toContain("-m gpt-5.5");
    expect(exec).toContain("model_reasoning_effort=high");
    expect(exec).toContain("--output-schema /work/.task/schema.json");
    // The login goes in through stdin, never on the command line.
    expect(ws.commands.join("\n")).not.toContain("first");
    expect(ws.files.get("/work/.codex/auth.json")).toBe('{"tokens":"rotated"}');
    expect(stored).toEqual(['{"tokens":"rotated"}']);
    expect(ws.state.closed).toBe(true);
  });

  it("logs in with an API key through stdin and maps a 401 to UNAUTHENTICATED without the key", async () => {
    const apiKey = "sk-proj-codex-test-key-not-real-1234";
    const ws = fakeWorkspace(
      [JSON.stringify({ type: "error", message: `401 Unauthorized for ${apiKey}` })],
      1,
    );
    const runtime = createCodexAgentRuntime({
      workspace: ws.provider,
      model: "gpt-5.5",
      credential: async () => ({ kind: "api_key", apiKey }),
    });
    const error = await runtime.run(testTenant(), task()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudixError);
    expect((error as StudixError).code).toBe("UNAUTHENTICATED");
    expect((error as StudixError).message).not.toContain(apiKey);
    expect(ws.commands.some((c) => c.includes("codex login --with-api-key"))).toBe(true);
    expect(ws.commands.join("\n")).not.toContain(apiKey);
    expect(ws.state.closed).toBe(true);
  });

  it("refuses a model id that is not a safe argument", () => {
    const ws = fakeWorkspace([]);
    expect(() =>
      createCodexAgentRuntime({
        workspace: ws.provider,
        model: "gpt-5; rm -rf /",
        credential: async () => ({ kind: "api_key", apiKey: "x" }),
      }),
    ).toThrow(StudixError);
  });
});
