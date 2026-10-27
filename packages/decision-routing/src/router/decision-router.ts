import { scopeFromTenant, setSpanAttributes, withSpan } from "@studix/observability";
import { type Clock, type Logger, systemClock } from "@studix/shared";
import {
  abortableSleep,
  createDeadline,
  type Deadline,
  deadlineError,
  raceWithSignal,
} from "../abort-signals.ts";
import { failureCostCents, failureReason, failureUsage, sanitizeDecisionError } from "../decision-errors.ts";
import { validateDecisionRequest } from "../decision-request-validation.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult, FallbackStep } from "../decision-types.ts";
import { CircuitBreaker, type CircuitBreakerOptions } from "./circuit-breaker.ts";
import { type DecisionRoute, DecisionRouteTable } from "./decision-route-table.ts";
import { fingerprintOf, IdempotencyCache, type IdempotencyCacheOptions } from "./idempotency-cache.ts";
import { type ProviderExecutionSink, recordExecution } from "./provider-execution-sink.ts";
import {
  accountSpend,
  exhaustedError,
  finalizeResult,
  newRouteState,
  type RouteState,
} from "./route-state.ts";

export interface DecisionRouterOptions {
  providers: readonly DecisionProvider[];
  routes?: Record<string, DecisionRoute>;
  defaultRoute?: DecisionRoute;
  failClosedPrefixes?: readonly string[];
  /** Attempts per provider before falling back (retryable failures only). Default 2. */
  maxAttemptsPerProvider?: number;
  /** First retry delay; doubles per attempt, capped at 5s. Default 250ms. */
  retryBackoffMs?: number;
  sink?: ProviderExecutionSink;
  circuitBreaker?: CircuitBreakerOptions | false;
  idempotency?: IdempotencyCacheOptions | false;
  clock?: Clock;
  logger?: Logger;
  /** Backoff sleep; injectable so tests run without real delays. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const MAX_BACKOFF_MS = 5_000;

/** A cached result costs nothing again and its execution is already attributed to the call that ran it. */
function asReplay<T>(result: DecisionResult<T>): DecisionResult<T> {
  const { providerExecutionId: _first, ...rest } = result;
  return { ...rest, costCents: 0, replayed: true };
}

/**
 * Jev policy layer: per-kind provider chains, per-call budget and deadline, bounded retries of retryable
 * failures, fallback on failure / invalid output / budget, circuit breaking, idempotency, execution
 * records and spans. Exhausting the chain always throws: no valid decision means no decision.
 */
export class DecisionRouter implements DecisionProvider {
  readonly id = "router";
  readonly #table: DecisionRouteTable;
  readonly #clock: Clock;
  readonly #logger?: Logger;
  readonly #sink?: ProviderExecutionSink;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #breaker?: CircuitBreaker;
  readonly #cache?: IdempotencyCache;

  constructor(options: DecisionRouterOptions) {
    this.#table = new DecisionRouteTable(options);
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger;
    this.#sink = options.sink;
    this.#maxAttempts = Math.max(1, Math.floor(options.maxAttemptsPerProvider ?? 2));
    this.#backoffMs = Math.max(0, options.retryBackoffMs ?? 250);
    this.#sleep = options.sleep ?? abortableSleep;
    if (options.circuitBreaker !== false)
      this.#breaker = new CircuitBreaker(this.#clock, options.circuitBreaker);
    if (options.idempotency !== false) this.#cache = new IdempotencyCache(this.#clock, options.idempotency);
  }

  providerIds(): string[] {
    return this.#table.providerIds();
  }

  estimateCostCents(request: DecisionRequest<unknown>): number {
    const first = this.#table.chainFor(request.kind)[0];
    return first ? first.estimateCostCents(request) : 0;
  }

  async decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    validateDecisionRequest(request);
    const chain = this.#table.chainFor(request.kind);
    if (!this.#cache) return this.#route(request, chain);
    const { tenant, kind, idempotencyKey } = request;
    const key = `${tenant.organizationId}:${tenant.workspaceId}:${kind}:${idempotencyKey}`;
    return this.#cache.run(
      key,
      fingerprintOf({ input: request.input, version: request.schemaVersion }),
      () => this.#route(request, chain),
      asReplay,
    );
  }

  #route<T>(request: DecisionRequest<T>, chain: DecisionProvider[]): Promise<DecisionResult<T>> {
    const scope = scopeFromTenant(request.tenant, { jobId: request.jobId, stage: request.stageId });
    const attributes = {
      "studix.decision.kind": request.kind,
      "studix.decision.trace_id": request.idempotencyKey,
      "studix.decision.budget_cents": request.budgetCents,
      "studix.decision.chain": chain.map((p) => p.id),
    };
    return withSpan("decision.decide", { scope, attributes }, async (span) => {
      const started = this.#clock.now().getTime();
      const deadline = createDeadline(request.timeoutMs, request.signal);
      const state = newRouteState();
      try {
        for (const provider of chain) {
          const result = await this.#tryProvider(request, provider, state, deadline, started);
          if (!result) continue;
          const final = finalizeResult(request, result, state, this.#clock.now().getTime() - started);
          setSpanAttributes(
            span,
            {
              "studix.decision.cost_cents": final.costCents,
              "studix.decision.attempts": final.attempts,
              "studix.decision.input_tokens": final.usage.inputTokens,
              "studix.decision.output_tokens": final.usage.outputTokens,
              "studix.decision.latency_ms": final.latencyMs,
              "studix.decision.fallback_reason": final.fallbackReason,
            },
            { provider: final.providerId, model: final.model },
          );
          return final;
        }
        throw exhaustedError(request, state);
      } finally {
        deadline.dispose();
      }
    });
  }

  /** Run up to maxAttempts on one provider. Returns the result, or undefined to fall back. */
  async #tryProvider<T>(
    request: DecisionRequest<T>,
    provider: DecisionProvider,
    state: RouteState,
    deadline: Deadline,
    started: number,
  ): Promise<DecisionResult<T> | undefined> {
    const skip = (reason: "circuit_open" | "budget_exceeded") =>
      state.steps.push({
        providerId: provider.id,
        attempt: 0,
        outcome: "skipped",
        reason,
        latencyMs: 0,
        costCents: 0,
      });
    if (this.#breaker?.isOpen(provider.id)) return void skip("circuit_open");
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (deadline.signal.aborted) throw deadlineError(deadline, request.timeoutMs);
      const remainingBudget = request.budgetCents - state.spent;
      if (provider.estimateCostCents(request) > remainingBudget) return void skip("budget_exceeded");
      const remainingMs = Math.max(1, request.timeoutMs - (this.#clock.now().getTime() - started));
      const attemptStarted = this.#clock.now().getTime();
      state.attempts += 1;
      try {
        const result = await withSpan(
          "decision.provider_call",
          { scope: { provider: provider.id }, attributes: { "studix.decision.attempt": attempt } },
          () =>
            raceWithSignal(
              provider.decide({
                ...request,
                budgetCents: remainingBudget,
                timeoutMs: remainingMs,
                signal: deadline.signal,
              }),
              deadline.signal,
            ),
        );
        const latencyMs = this.#clock.now().getTime() - attemptStarted;
        accountSpend(state, result.costCents, result.usage);
        const step: FallbackStep = {
          providerId: provider.id,
          model: result.model,
          attempt,
          outcome: "succeeded",
          latencyMs,
          costCents: result.costCents,
        };
        state.steps.push(step);
        this.#breaker?.recordSuccess(provider.id);
        const executionId = await recordExecution(this.#sink, this.#logger, request, {
          providerId: provider.id,
          model: result.model,
          attempt,
          latencyMs,
          costCents: result.costCents,
          usage: result.usage,
        });
        if (!executionId) return result;
        step.executionId = executionId;
        return { ...result, providerExecutionId: executionId };
      } catch (thrown) {
        const error = deadline.signal.aborted
          ? deadlineError(deadline, request.timeoutMs)
          : sanitizeDecisionError(thrown);
        const reason = failureReason(error);
        const costCents = failureCostCents(error);
        const usage = failureUsage(error);
        const model = typeof error.details?.model === "string" ? error.details.model : undefined;
        const latencyMs = this.#clock.now().getTime() - attemptStarted;
        accountSpend(state, costCents, usage);
        const step: FallbackStep = {
          providerId: provider.id,
          ...(model ? { model } : {}),
          attempt,
          outcome: "failed",
          reason,
          errorCode: error.code,
          latencyMs,
          costCents,
        };
        state.steps.push(step);
        state.lastError = error;
        this.#breaker?.recordFailure(provider.id, reason);
        const executionId = await recordExecution(this.#sink, this.#logger, request, {
          providerId: provider.id,
          model,
          attempt,
          latencyMs,
          costCents,
          usage,
          error,
        });
        if (executionId) step.executionId = executionId;
        if (deadline.signal.aborted || error.code === "VALIDATION") throw error;
        if (!error.retryable || attempt === this.#maxAttempts) return undefined;
        const hinted = error.details?.retryAfterMs;
        const delay = Math.min(
          MAX_BACKOFF_MS,
          typeof hinted === "number" ? hinted : this.#backoffMs * 2 ** (attempt - 1),
        );
        try {
          await this.#sleep(delay, deadline.signal);
        } catch {
          throw deadlineError(deadline, request.timeoutMs);
        }
      }
    }
    return undefined;
  }
}
