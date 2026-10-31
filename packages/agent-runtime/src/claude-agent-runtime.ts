import type { AgentRunResult, AgentRuntime, AgentTask, TenantContext } from "@studix/core";
import { type Clock, StudixError, systemClock } from "@studix/shared";
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
  resolve(ctx: TenantContext, signal?: AbortSignal): Promise<string>;
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

/** Map anything thrown by the transport; keys are redacted and 401/403/429 are recognised. */
export function mapClaudeThrown(err: unknown): StudixError {
  if (err instanceof StudixError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const raw = (err as { status?: unknown } | null)?.status;
  const status = typeof raw === "number" ? raw : Number(/\b(401|403|429)\b/.exec(message)?.[1]) || undefined;
  return mapClaudeError(status, message);
}

function timeout(ms: number): { promise: Promise<"timeout">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Wait for the process to exit, tolerating a rejecting `closed` (non-zero exit after interrupt). */
async function waitClosed(session: ClaudeAgentSession, ms: number): Promise<boolean> {
  const t = timeout(ms);
  try {
    const r = await Promise.race([
      session.closed.then(
        () => "closed" as const,
        () => "closed" as const,
      ),
      t.promise,
    ]);
    return r === "closed";
  } finally {
    t.cancel();
  }
}

/**
 * AgentRuntime backed by the Claude Agent SDK. Unlike the bounded wrapper, limits are enforced while
 * the session runs: turns and cost stop the process mid-run, abort and deadline interrupt then kill
 * it, and `run` only settles after the process has closed. Once the run is stopping or finished no
 * tool call is permitted. A failure seen before a stop wins over the stop reason; a process that
 * survives a kill is reported as INTERNAL whatever else happened.
 */
export function createClaudeAgentRuntime(options: ClaudeAgentRuntimeOptions): AgentRuntime {
  const clock = options.clock ?? systemClock;
  const killAfterMs = options.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  return {
    id: CLAUDE_AGENT_RUNTIME_ID,
    async run(ctx, task) {
      assertAgentTask(task, clock.now());
      if (task.maxCostCents <= 0)
        throw new StudixError(
          "VALIDATION",
          "Invalid agent task: maxCostCents must be > 0 for the Claude runtime",
        );
      if (task.signal?.aborted) throw abortReason(task.signal);

      // Abort and deadline are armed before anything slow (credential lookup) happens.
      let stopReason: StudixError | undefined;
      let closing = false;
      let session: ClaudeAgentSession | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let signalStop!: () => void;
      const stopped = new Promise<"stopped">((resolve) => {
        signalStop = () => resolve("stopped");
      });
      const stop = (reason: StudixError) => {
        if (stopReason) return;
        stopReason = reason;
        closing = true;
        signalStop();
        if (session) {
          session.interrupt();
          killTimer = setTimeout(() => session?.kill(), killAfterMs);
        }
      };
      const onAbort = () => stop(abortReason(task.signal!));
      task.signal?.addEventListener("abort", onAbort, { once: true });
      const deadlineTimer = task.deadlineAt
        ? setTimeout(
            () => stop(new StudixError("TIMEOUT", "agent task deadline reached", { retryable: false })),
            Math.min(2 ** 31 - 1, Math.max(0, task.deadlineAt.getTime() - clock.now().getTime())),
          )
        : undefined;

      const allowed = new Set((task.tools ?? []).map((t) => t.name));
      let usage = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, model: options.model };
      let final: { output: unknown } | undefined;
      let failure: StudixError | undefined;
      let iterator: AsyncIterator<ClaudeAgentEvent> | undefined;
      try {
        const credential = await Promise.race([options.credentials.resolve(ctx, task.signal), stopped]);
        if (credential === "stopped") throw stopReason;
        if (stopReason) throw stopReason;
        session = options.transport.start({
          model: options.model,
          instructions: task.instructions,
          input: task.input,
          allowedTools: [...allowed],
          outputSchema: task.outputSchema,
          maxTurns: task.maxTurns,
          maxBudgetUsd: task.maxCostCents / 100,
          credential,
          canUseTool: async (name) => !closing && allowed.has(name),
        });
        iterator = session.events[Symbol.asyncIterator]();
        while (!stopReason) {
          // Racing the stop signal keeps a silent process from holding the loop open.
          const next = await Promise.race([iterator.next(), stopped]);
          if (next === "stopped" || next.done) break;
          const event = next.value;
          if (event.type === "usage") {
            const num = (v: number, prev: number) => (Number.isFinite(v) ? Math.max(v, prev) : Number.NaN);
            usage = {
              turns: num(event.turns, usage.turns),
              inputTokens: num(event.inputTokens, usage.inputTokens),
              outputTokens: num(event.outputTokens, usage.outputTokens),
              costUsd: num(event.costUsd, usage.costUsd),
              model: event.model ?? usage.model,
            };
            if (Object.values(usage).some((v) => typeof v === "number" && Number.isNaN(v))) {
              failure = new StudixError("PROVIDER_ERROR", "agent reported invalid usage", {
                retryable: false,
              });
              break;
            }
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
            } else if (usage.costUsd * 100 > task.maxCostCents) {
              stop(
                new StudixError(
                  "BUDGET_EXCEEDED",
                  `agent cost ${(usage.costUsd * 100).toFixed(2)}¢ exceeds the ${task.maxCostCents}¢ task limit`,
                  { retryable: false },
                ),
              );
            }
          } else if (event.type === "result") {
            final = { output: event.output };
            break;
          } else {
            failure = mapClaudeError(event.status, event.message);
            break;
          }
        }
      } catch (err) {
        if (err !== stopReason) failure ??= mapClaudeThrown(err);
      } finally {
        closing = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        task.signal?.removeEventListener("abort", onAbort);
        // The iterator may be stuck in next(); never await its return().
        void Promise.resolve(iterator?.return?.()).catch(() => {});
        if (session) {
          if (!stopReason) session.interrupt();
          let exited = await waitClosed(session, killAfterMs);
          if (!exited) {
            session.kill();
            exited = await waitClosed(session, closeTimeoutMs);
          }
          if (killTimer) clearTimeout(killTimer);
          if (!exited) {
            failure = new StudixError("INTERNAL", "agent process did not exit after kill", {
              retryable: false,
              details: { stopCode: stopReason?.code },
            });
            stopReason = undefined;
          }
        }
      }

      if (failure) throw withSpend(failure, usage);
      if (stopReason) throw withSpend(stopReason, usage);
      if (!final)
        throw withSpend(new StudixError("PROVIDER_ERROR", "agent finished without a result"), usage);
      let output: unknown;
      try {
        output = (options.validateOutput ?? defaultValidate)(final.output, task);
      } catch (err) {
        throw withSpend(
          new StudixError("PROVIDER_ERROR", "agent output failed validation", {
            retryable: false,
            cause: err,
          }),
          usage,
        );
      }
      const result: AgentRunResult = {
        output,
        turns: usage.turns,
        costCents: Math.round(usage.costUsd * 1e6) / 1e4,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        model: usage.model,
      };
      return result;
    },
  };
}

/** What a failed run had already spent, as reported by the agent before it stopped. */
export interface AgentSpend {
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  model?: string;
}

/** The spend carried by an error from `createClaudeAgentRuntime().run`, if the agent reported any. */
export function agentSpendOf(err: unknown): AgentSpend | undefined {
  const spent = err instanceof StudixError ? err.details?.spent : undefined;
  return spent && typeof spent === "object" ? (spent as AgentSpend) : undefined;
}

/**
 * A run that fails after the agent reported usage still cost money on the tenant's key. The spend rides on
 * the error so the caller can bill it, and the error is no longer retryable: a retry would pay again.
 */
function withSpend(
  err: StudixError,
  usage: { turns: number; inputTokens: number; outputTokens: number; costUsd: number; model?: string },
): StudixError {
  if (!(usage.costUsd > 0 || usage.inputTokens > 0 || usage.outputTokens > 0)) return err;
  const spent: AgentSpend = {
    costCents: Math.round(usage.costUsd * 1e6) / 1e4,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    turns: usage.turns,
    model: usage.model,
  };
  return new StudixError(err.code, err.message, {
    retryable: false,
    suggestedAction: err.suggestedAction,
    details: { ...err.details, spent },
    cause: err,
  });
}

function defaultValidate(output: unknown): unknown {
  if (output === null || output === undefined) throw new Error("output is empty");
  return output;
}
