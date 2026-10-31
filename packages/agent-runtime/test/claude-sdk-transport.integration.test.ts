import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  type ClaudeSpawnedProcess,
  type ClaudeSpawnOptions,
  createClaudeAgentRuntime,
  createClaudeSdkTransport,
} from "../src/index.ts";
import { type MockAnthropicServer, startMockAnthropicServer } from "./fixtures/mock-anthropic-server.ts";

/**
 * Runs the pinned SDK and its bundled Claude runtime for real, against a local Messages API stand-in,
 * so no token is spent. Proves what unit fakes cannot: which tools reach the model, that structured
 * output works with every built-in tool removed, and that cancel ends the process.
 */
const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "sdk-integration",
  instructions: "Return ok in the answer field.",
  input: { prompt: "coffee" },
  outputSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
  maxCostCents: 100,
  maxTurns: 1,
  ...overrides,
});

describe("claude runtime over the real SDK transport", () => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), "studix-claude-it-"));
  let server: MockAnthropicServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  afterAll(() => rmSync(sandboxRoot, { recursive: true, force: true }));

  function runtimeFor(baseUrl: string, spawned: ClaudeSpawnedProcess[]) {
    return createClaudeAgentRuntime({
      model: "claude-sonnet-5-5",
      credentials: { resolve: async () => "sk-ant-integration-not-a-real-key" },
      transport: createClaudeSdkTransport({
        baseUrl,
        sandboxRoot,
        spawnProcess: (options: ClaudeSpawnOptions) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "ignore"],
          }) as unknown as ClaudeSpawnedProcess;
          spawned.push(child);
          return child;
        },
      }),
    });
  }

  const allExited = (spawned: ClaudeSpawnedProcess[]) =>
    spawned.every((child) => child.exitCode !== null || child.signalCode !== null);

  it("returns structured output in one model call with only the structured-output tool offered", async () => {
    server = await startMockAnthropicServer("answer");
    const spawned: ClaudeSpawnedProcess[] = [];
    const result = await runtimeFor(server.baseUrl, spawned).run(testTenant(), task());

    expect(result).toMatchObject({ output: { answer: "ok" }, turns: 1, inputTokens: 1000, outputTokens: 50 });
    expect(result.costCents).toBeGreaterThan(0);
    const calls = server.requests.filter(
      (r) => r.url.startsWith("/v1/messages?") || r.url === "/v1/messages",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKeyHeader).toBe(true);
    for (const tool of calls[0]!.tools) {
      expect(["StructuredOutput", "DeferredToolPlaceholder"]).toContain(tool);
    }
    expect(spawned).toHaveLength(1);
    expect(allExited(spawned)).toBe(true);
    expect(readdirSync(sandboxRoot)).toEqual([]);
  });

  it("ends the Claude process and removes the sandbox when cancelled mid-call", async () => {
    server = await startMockAnthropicServer("hang");
    const spawned: ClaudeSpawnedProcess[] = [];
    const controller = new AbortController();
    const running = runtimeFor(server.baseUrl, spawned).run(
      testTenant(),
      task({ signal: controller.signal }),
    );
    await expect.poll(() => server!.requests.length, { timeout: 60_000 }).toBeGreaterThan(0);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(spawned).toHaveLength(1);
    expect(allExited(spawned)).toBe(true);
    expect(readdirSync(sandboxRoot)).toEqual([]);
  });
});
