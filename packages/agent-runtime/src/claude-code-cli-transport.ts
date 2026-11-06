import { createInterface } from "node:readline";
import { StudixError } from "@studix/shared";
import type {
  ClaudeAgentSession,
  ClaudeAgentTransport,
  ClaudeSessionRequest,
} from "./claude-agent-runtime.ts";
import {
  type ClaudeMessage,
  type ClaudeQueryFn,
  type ClaudeQueryOptions,
  type ClaudeSdkTransportOptions,
  createClaudeSdkTransport,
} from "./claude-sdk-transport.ts";

/*
 * Runs a user's own Claude subscription the only way Anthropic allows a product to: the official,
 * unmodified Claude Code binary, signed in with the token its own `claude setup-token` printed. The Agent
 * SDK is never loaded here and the token is never sent anywhere but to that binary's environment
 * (`CLAUDE_CODE_OAUTH_TOKEN`). Sandbox, process ownership and result mapping are the SDK transport's.
 */

/** Command-line flags for one non-interactive, tool-less, settings-free Claude Code run. */
export function claudeCodeCliArgs(options: ClaudeQueryOptions): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--max-turns",
    String(options.maxTurns),
    "--max-budget-usd",
    String(options.maxBudgetUsd),
    "--system-prompt",
    options.systemPrompt,
    "--tools",
    options.tools.join(","),
    "--setting-sources",
    "",
    "--permission-mode",
    options.permissionMode,
    "--no-session-persistence",
  ];
  if (options.outputFormat) args.push("--json-schema", JSON.stringify(options.outputFormat.schema));
  return args;
}

/** A `query` that spawns the Claude Code executable directly and reads its stream-json output. */
export function createClaudeCodeCliQuery(executable: string): ClaudeQueryFn {
  return async function* ({ prompt, options }): AsyncGenerator<ClaudeMessage> {
    const child = options.spawnClaudeCodeProcess({
      command: executable,
      args: claudeCodeCliArgs(options),
      cwd: options.cwd,
      env: options.env,
      signal: options.abortController.signal,
    });
    const onAbort = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    };
    options.abortController.signal.addEventListener("abort", onAbort, { once: true });
    const exit = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(typeof code === "number" ? code : null));
      child.once("error", () => resolve(null));
    });
    try {
      child.stdin.end(prompt);
      const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
      let sawResult = false;
      for await (const line of lines) {
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message && typeof message === "object" && typeof (message as ClaudeMessage).type === "string") {
          if ((message as ClaudeMessage).type === "result") sawResult = true;
          yield message as ClaudeMessage;
        }
      }
      const code = await exit;
      if (!sawResult) throw new Error(`Claude Code exited with code ${code ?? "unknown"} and no result`);
    } finally {
      options.abortController.signal.removeEventListener("abort", onAbort);
    }
  };
}

export interface ClaudeCodeCliTransportOptions
  extends Omit<ClaudeSdkTransportOptions, "query" | "credentialKind" | "baseUrl"> {
  /** The official Claude Code executable, as published (e.g. the one preflightClaudeRuntime found). */
  executable: string;
}

/** `ClaudeAgentTransport` for `subscription` credentials, over the Claude Code binary only. */
export function createClaudeCodeCliTransport(options: ClaudeCodeCliTransportOptions): ClaudeAgentTransport {
  const { executable, ...rest } = options;
  return createClaudeSdkTransport({
    ...rest,
    query: createClaudeCodeCliQuery(executable),
    credentialKind: "subscription",
  });
}

/**
 * Picks the transport by credential kind: API keys go to `apiKey` (the Agent SDK), subscriptions only to
 * `subscription` (the Claude Code binary). Without a subscription transport a subscription is refused.
 */
export function createClaudeRoutingTransport(transports: {
  apiKey: ClaudeAgentTransport;
  subscription?: ClaudeAgentTransport;
}): ClaudeAgentTransport {
  return {
    start(request: ClaudeSessionRequest): ClaudeAgentSession {
      if ((request.credentialKind ?? "api_key") === "api_key") return transports.apiKey.start(request);
      if (!transports.subscription) {
        throw new StudixError("UNAVAILABLE", "This server does not run Claude subscriptions", {
          retryable: false,
          suggestedAction: "Ask the operator to enable STUDIX_CLAUDE_SUBSCRIPTION, or use an API key.",
        });
      }
      return transports.subscription.start(request);
    },
  };
}
