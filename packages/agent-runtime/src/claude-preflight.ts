import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudixError } from "@studix/shared";
import {
  type ClaudeQueryFn,
  type ClaudeQueryOptions,
  type ClaudeSpawnOptions,
  loadClaudeSdkQuery,
} from "./claude-sdk-transport.ts";

export interface ClaudePreflightOptions {
  /** The SDK `query`. Defaults to `@anthropic-ai/claude-agent-sdk`, as in the transport. */
  query?: ClaudeQueryFn;
  pathToClaudeCodeExecutable?: string;
  /** Upper bound for the whole check. Default 20 s. */
  timeoutMs?: number;
}

export interface ClaudePreflightResult {
  command: string;
  version: string;
}

const PROBE_STOP = "Claude preflight: runtime located";

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unavailable(reason: string): StudixError {
  return new StudixError("UNAVAILABLE", `The Claude runtime cannot start on this host: ${reason}`, {
    retryable: false,
    suggestedAction:
      "Install the Claude Agent SDK's runtime for this platform (for example the matching optional dependency), set a working executable path, or turn the Claude planner off.",
    details: { platform: process.platform, arch: process.arch },
  });
}

function runVersion(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args, "--version"],
      { cwd, timeout: timeoutMs, env: { PATH: process.env.PATH ?? "", HOME: cwd }, encoding: "utf8" },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
}

/**
 * Check, without calling Anthropic, that the Claude process the SDK would launch exists and runs here.
 * It lets the SDK resolve its own executable through the same spawn hook the transport uses, captures the
 * command it would run instead of starting a session, and runs that command with `--version`. A missing
 * platform binary, a wrong architecture or a non-executable file therefore fails once, at startup, instead
 * of on every job. Throws a non-retryable UNAVAILABLE StudixError.
 */
export async function preflightClaudeRuntime(
  options: ClaudePreflightOptions = {},
): Promise<ClaudePreflightResult> {
  const query = options.query ?? loadClaudeSdkQuery();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const sandbox = mkdtempSync(join(tmpdir(), "studix-claude-preflight-"));
  const abortController = new AbortController();
  let captured: ClaudeSpawnOptions | undefined;
  const queryOptions: ClaudeQueryOptions = {
    model: "preflight",
    maxTurns: 1,
    maxBudgetUsd: 0,
    cwd: sandbox,
    env: { PATH: process.env.PATH ?? "", HOME: sandbox, ANTHROPIC_API_KEY: "preflight-no-request" },
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    canUseTool: async () => ({ behavior: "deny", message: "preflight", interrupt: true }),
    settingSources: [],
    persistSession: false,
    abortController,
    systemPrompt: "preflight",
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    spawnClaudeCodeProcess: (spawnOptions) => {
      captured = spawnOptions;
      throw new Error(PROBE_STOP);
    },
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const probe = (async () => {
      try {
        const stream = await query({ prompt: "preflight", options: queryOptions });
        for await (const _message of stream) {
          if (captured) break;
        }
      } catch (err) {
        if (!captured) throw unavailable(reasonOf(err));
      }
    })();
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(unavailable(`no answer within ${timeoutMs} ms`)), timeoutMs);
    });
    await Promise.race([probe, timedOut]);
    if (!captured) throw unavailable("the SDK did not locate a Claude executable");
    // A node-script runtime passes the script first; the flags that follow belong to the session.
    const scriptArgs = captured.args.slice(
      0,
      Math.max(
        0,
        captured.args.findIndex((arg) => arg.startsWith("-")),
      ),
    );
    const version = await runVersion(captured.command, scriptArgs, sandbox, timeoutMs).catch((err) => {
      throw unavailable(`${captured?.command} did not run (${reasonOf(err)})`);
    });
    return { command: captured.command, version };
  } finally {
    clearTimeout(timer);
    abortController.abort();
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover empty directory under the OS temp dir is harmless.
    }
  }
}
