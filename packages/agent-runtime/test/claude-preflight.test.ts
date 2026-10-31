import { describe, expect, it } from "vitest";
import { type ClaudeQueryFn, type ClaudeQueryOptions, preflightClaudeRuntime } from "../src/index.ts";

/** A query that asks the transport hook to spawn `command`, as the SDK does once it has found its binary. */
function spawning(command: string, args: string[] = ["--output-format", "stream-json"]): ClaudeQueryFn {
  return async ({ options }: { options: ClaudeQueryOptions }) => {
    options.spawnClaudeCodeProcess({
      command,
      args,
      env: options.env,
      signal: options.abortController.signal,
    });
    return (async function* () {})();
  };
}

describe("preflightClaudeRuntime", () => {
  it("runs the executable the SDK would launch and reports its version", async () => {
    const result = await preflightClaudeRuntime({ query: spawning(process.execPath, []) });
    expect(result.command).toBe(process.execPath);
    expect(result.version).toMatch(/^v\d+\./);
  });

  it("keeps a node script and its runtime flags, so a missing script fails", async () => {
    const missing = spawning(process.execPath, [
      "--no-warnings",
      "/nonexistent/cli.js",
      "--output-format",
      "x",
    ]);
    await expect(preflightClaudeRuntime({ query: missing })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("fails with non-retryable UNAVAILABLE when the executable is missing", async () => {
    await expect(preflightClaudeRuntime({ query: spawning("/nonexistent/claude") })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: false,
    });
  });

  it("fails when the SDK cannot find a runtime for this platform", async () => {
    const query: ClaudeQueryFn = async () => {
      throw new Error("Native CLI binary for linux-arm64 not found");
    };
    await expect(preflightClaudeRuntime({ query })).rejects.toThrow(/linux-arm64 not found/);
  });

  it("fails when the SDK never reaches the spawn hook", async () => {
    const query: ClaudeQueryFn = async () => (async function* () {})();
    await expect(preflightClaudeRuntime({ query })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("gives up after the timeout", async () => {
    const query: ClaudeQueryFn = () => new Promise(() => {});
    await expect(preflightClaudeRuntime({ query, timeoutMs: 50 })).rejects.toThrow(/no answer within 50 ms/);
  });
});
