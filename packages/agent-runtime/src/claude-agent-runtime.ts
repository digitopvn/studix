import type { AgentRunResult, AgentRuntime, AgentTask, TenantContext } from "@studix/core";
import { type Clock, StudixError, systemClock, toStudixError } from "@studix/shared";
import { abortReason, assertAgentTask } from "./bounded-agent-runtime.ts";

export const CLAUDE_AGENT_RUNTIME_ID = "claude-agent-sdk";

/** What the transport needs to start one isolated agent session. */
export interface ClaudeSessionRequest {
  model: string;
  instructions: string;
  input: Record<string, unknown>;
  /** Tool names the agent may call; everything else is denied. */
  allowedTools: readonly string[];
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
  /** The SDK's own cap; the runtime enforces its own cap on top of it. */
  maxBudgetUsd: number;
  /** Credential for this job only (an `sk-ant-…` key); never logged or placed in prompts. */
  credential: string;
  /** Called before every tool execution. Must be awaited by the transport; `false` denies. */
  canUseTool(toolName: string, toolInput: unknown): Promise<boolean>;
}

export type ClaudeAgentEvent =
  | {
      type: "usage";
      turns: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      model?: string;
    }
  | { type: "result"; output: unknown }
  | { type: "error"; status?: number; message: string };

/** One running agent process (SDK subprocess). The runtime never trusts it to stop on its own. */
export interface ClaudeAgentSession {
  readonly events: AsyncIterable<ClaudeAgentEvent>;
  /** Ask the agent to stop gracefully. */
  interrupt(): void;
  /** Kill the process tree. Must be idempotent. */
  kill(): void;
  /** Resolves once the process has exited and its children, files and memory are released. */
  readonly closed: Promise<void>;
}

/** The only seam to `@anthropic-ai/claude-agent-sdk`; CI uses a fake, live runs inject the real one. */
export interface ClaudeAgentTransport {
  start(request: ClaudeSessionRequest): ClaudeAgentSession;
}

export interface ClaudeCredentialResolver {
  /** Resolve the credential this tenant is allowed to use; throws UNAUTHENTICATED/FORBIDDEN/UNAVAILABLE. */
  resolve(ctx: TenantContext): Promise<string>;
}

export interface ClaudeAgentRuntimeOptions {
  transport: ClaudeAgentTransport;
  credentials: ClaudeCredentialResolver;
  model: string;
  /** Validates the final output; defaults to requiring a non-null value. Throws to reject. */
  validateOutput?: (output: unknown, task: AgentTask) => unknown;
  /** Grace between interrupt and hard kill. */
  killAfterMs?: number;
  /** Upper bound on waiting for the process to exit after a kill. */
  closeTimeoutMs?: number;
  clock?: Clock;
}

const DEFAULT_KILL_AFTER_MS = 2_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/** Map an upstream HTTP status to a normalized error, without ever echoing credentials. */
export function mapClaudeError(status: number | undefined, message: string): StudixError {
  const safe = message.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
  if (status === 401)
    return new StudixError("UNAUTHENTICATED", "Anthropic rejected the API key", {
      retryable: false,
      suggestedAction: "Replace or re-test the Anthropic API key in Settings → AI & Providers.",
    });
  if (status === 403)
    return new StudixError("FORBIDDEN", "The Anthropic key is not allowed to use this model", {
      retryable: false,
      suggestedAction: "Check the key's organization permissions and model access.",
    });
  if (status === 429) return new StudixError("RATE_LIMITED", "Anthropic rate limit or quota reached");
  return new StudixError("PROVIDER_ERROR", `Claude agent failed: ${safe}`);
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms).unref?.());
}

/**
 * AgentRuntime backed by the Claude Agent SDK. Unlike the bounded wrapper, limits are enforced while
 * the session runs: turns and cost stop the process mid-run, abort and deadline interrupt then kill
 * it, and `run` only settles after the process has closed. After an abort no tool call is permitted.
 */
export function createClaudeAgentRuntime(options: ClaudeAgentRuntimeOptions): AgentRuntime {
  const clock = options.clock ?? systemClock;
  const killAfterMs = options.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  return {
    id: CLAUDE_AGENT_RUNTIME_ID,
    async run(ctx, task) {
      assertAgentTask(task, clock.now());
      if (task.signal?.aborted) throw abortReason(task.signal);
      const credential = await options.credentials.resolve(ctx);

      let stopReason: StudixError | undefined;
      const allowed = new Set((task.tools ?? []).map((t) => t.name));
      const session = options.transport.start({
        model: options.model,
        instructions: task.instructions,
        input: task.input,
        allowedTools: [...allowed],
        outputSchema: task.outputSchema,
        maxTurns: task.maxTurns,
        maxBudgetUsd: task.maxCostCents / 100,
        credential,
        canUseTool: async (name) => stopReason === undefined && allowed.has(name),
      });

      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let signalStop!: () => void;
      const stopped = new Promise<"stopped">((resolve) => {
        signalStop = () => resolve("stopped");
      });
      const stop = (reason: StudixError) => {
        if (stopReason) return;
        stopReason = reason;
        signalStop();
        session.interrupt();
        killTimer = setTimeout(() => session.kill(), killAfterMs);
      };
      const onAbort = () => stop(abortReason(task.signal!));
      task.signal?.addEventListener("abort", onAbort, { once: true });
      const deadlineTimer = task.deadlineAt
        ? setTimeout(
            () => stop(new StudixError("TIMEOUT", "agent task deadline reached", { retryable: false })),
            Math.max(0, task.deadlineAt.getTime() - clock.now().getTime()),
          )
        : undefined;

      let usage = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, model: options.model };
      let final: { output: unknown } | undefined;
      let failure: StudixError | undefined;
      try {
        const iterator = session.events[Symbol.asyncIterator]();
        while (!stopReason) {
          // Racing the stop signal keeps a silent process from holding the loop open.
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === "stopped" || next.done) break;
          const event = next.value;
          if (event.type === "usage") {
            usage = { ...usage, ...event, model: event.model ?? usage.model };
            if (usage.turns > task.maxTurns) {
              stop(
                new StudixError(
                  "PROVIDER_ERROR",
                  `agent used ${usage.turns} turns, over the ${task.maxTurns} limit`,
                  {
                    retryable: false,
                  },
                ),
              );
            } else if (!Number.isFinite(usage.costUsd) || usage.costUsd * 100 > task.maxCostCents) {
              stop(
                new StudixError(
                  "BUDGET_EXCEEDED",
                  `agent cost ${(usage.costUsd * 100).toFixed(2)}¢ exceeds the ${task.maxCostCents}¢ task limit`,
                  { retryable: false },
                ),
              );
            }
          } else if (event.type === "result") final = { output: event.output };
          else failure ??= mapClaudeError(event.status, event.message);
        }
      } catch (err) {
        failure ??= toStudixError(err, "PROVIDER_ERROR");
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        task.signal?.removeEventListener("abort", onAbort);
        // Whatever ended the loop, make sure the process is gone before reporting back.
        if (!stopReason && (!final || failure)) session.interrupt();
        const exited = await Promise.race([
          session.closed.then(() => "closed" as const),
          timeout(killAfterMs),
        ]);
        if (exited === "timeout") {
          session.kill();
          const killed = await Promise.race([
            session.closed.then(() => "closed" as const),
            timeout(closeTimeoutMs),
          ]);
          if (killed === "timeout")
            failure ??= new StudixError("INTERNAL", "agent process did not exit after kill", {
              retryable: false,
            });
        }
        if (killTimer) clearTimeout(killTimer);
      }

      if (stopReason) throw stopReason;
      if (failure) throw failure;
      if (!final) throw new StudixError("PROVIDER_ERROR", "agent finished without a result");
      let output: unknown;
      try {
        output = (options.validateOutput ?? defaultValidate)(final.output, task);
      } catch (err) {
        throw new StudixError("PROVIDER_ERROR", "agent output failed validation", {
          retryable: false,
          cause: err,
        });
      }
      const result: AgentRunResult = {
        output,
        turns: usage.turns,
        costCents: usage.costUsd * 100,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: usage.model,
      };
      return result;
    },
  };
}

function defaultValidate(output: unknown): unknown {
  if (output === null || output === undefined) throw new Error("output is empty");
  return output;
}
