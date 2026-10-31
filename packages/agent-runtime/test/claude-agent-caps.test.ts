import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import {
  agentCapOf,
  type ClaudeAgentEvent,
  type ClaudeMessage,
  type ClaudeSpawnedProcess,
  createClaudeAgentRuntime,
  createClaudeSdkTransport,
  createFakeClaudeTransport,
} from "../src/index.ts";

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "script",
  instructions: "Write a script",
  input: {},
  maxCostCents: 50,
  maxTurns: 3,
  maxTokens: 1000,
  ...overrides,
});

const runtimeOver = (events: ClaudeAgentEvent[] | (() => Promise<ClaudeAgentEvent[]>)) => {
  const transport = createFakeClaudeTransport(typeof events === "function" ? events : () => events);
  const runtime = createClaudeAgentRuntime({
    transport,
    model: "claude-test",
    killAfterMs: 20,
    closeTimeoutMs: 50,
    credentials: { resolve: async () => "sk-ant-api03-caps-test-key-0000000000" },
  });
  return { runtime, transport };
};

const usage = (u: Partial<Extract<ClaudeAgentEvent, { type: "usage" }>>): ClaudeAgentEvent => ({
  type: "usage",
  turns: 1,
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  ...u,
});

describe("claude agent runtime caps", () => {
  it.each([
    ["turns", usage({ turns: 4 })],
    ["tokens", usage({ inputTokens: 700, outputTokens: 301 })],
    ["cost", usage({ costUsd: 0.51 })],
  ] as const)("stops the session at the %s cap, before any result", async (cap, event) => {
    const { runtime, transport } = runtimeOver([event, { type: "result", output: { late: true } }]);
    const err = await runtime.run(testTenant(), task()).catch((e: unknown) => e);
    expect(agentCapOf(err)).toBe(cap);
    expect(err).toMatchObject({ retryable: false });
    expect(transport.sessions[0]).toMatchObject({ closed: true });
    expect(transport.sessions[0]!.interrupts).toBeGreaterThan(0);
  });

  it("stops a silent session at the time cap and closes it", async () => {
    const { runtime, transport } = runtimeOver(() => new Promise(() => {}));
    const err = await runtime
      .run(testTenant(), task({ deadlineAt: new Date(Date.now() + 30) }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(agentCapOf(err)).toBe("time");
    expect(transport.sessions[0]).toMatchObject({ closed: true });
  });

  it("redacts credentials from the output", async () => {
    const { runtime } = runtimeOver([
      usage({}),
      { type: "result", output: { text: "key sk-ant-api03-caps-test-key-0000000000 here" } },
    ]);
    const result = await runtime.run(testTenant(), task());
    expect(result.output).toEqual({ text: "key [redacted] here" });
  });
});

describe("claude agent subprocess on the time cap", () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "studix-claude-kill-"));
  afterAll(() => rmSync(sandboxRoot, { recursive: true, force: true }));

  it("kills a real child process that ignores the interrupt", async () => {
    let child: (ClaudeSpawnedProcess & { pid?: number }) | undefined;
    let onSpawn!: () => void;
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve;
    });
    const transport = createClaudeSdkTransport({
      sandboxRoot,
      // The SDK stand-in starts the agent process and then waits on it forever, ignoring the abort, so
      // only the runtime's kill can end the session.
      query: ({ options }) =>
        (async function* (): AsyncGenerator<ClaudeMessage> {
          child = options.spawnClaudeCodeProcess({
            command: process.execPath,
            args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
            env: options.env,
            signal: options.abortController.signal,
          });
          onSpawn();
          await new Promise(() => {});
        })(),
      spawnProcess: (o) =>
        spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"] }) as never,
    });
    const runtime = createClaudeAgentRuntime({
      transport,
      model: "claude-test",
      killAfterMs: 50,
      closeTimeoutMs: 5_000,
      credentials: { resolve: async () => "sk-ant-api03-kill-test-key-00000000000" },
    });
    const running = runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 300) }));
    await spawned;
    const pid = child!.pid!;
    expect(isAlive(pid)).toBe(true);

    const err = await running.catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(agentCapOf(err)).toBe("time");
    // run settled only after the process exited: it is gone, by a signal, not by its own exit.
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(isAlive(pid)).toBe(false);
  }, 15_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
