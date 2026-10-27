import { type Clock, type Logger, systemClock } from "@studix/shared";
import { abortableSleep } from "../abort-signals.ts";
import { decisionError } from "../decision-errors.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult, TokenUsage } from "../decision-types.ts";
import { executeProviderCall, ZERO_USAGE } from "../execute-provider-call.ts";

interface FakeStepBase {
  /** Simulated provider latency (real timer, honors abort). */
  delayMs?: number;
  costCents?: number;
  usage?: TokenUsage;
  model?: string;
}

/** One scripted provider response: an output (validated like real output) or a thrown error. */
export type FakeDecisionStep = (FakeStepBase & { output: unknown }) | (FakeStepBase & { error: unknown });

export interface FakeDecisionAdapterOptions {
  id?: string;
  /** Consumed in order, one per call. */
  steps?: FakeDecisionStep[];
  /** Used when the script is exhausted; omit to fail loudly instead. */
  fallback?: FakeDecisionStep;
  /** Pre-call estimate reported to budget checks. */
  estimateCostCents?: number;
  model?: string;
  clock?: Clock;
  logger?: Logger;
}

/** Scripted decision provider for CI and router tests. Never calls the network, never costs money. */
export class FakeDecisionAdapter implements DecisionProvider {
  readonly id: string;
  /** Every request this adapter received (including refused ones), in order. */
  readonly calls: DecisionRequest<unknown>[] = [];
  /** Requests that reached the scripted provider (passed validation, budget and cancellation checks). */
  readonly invocations: DecisionRequest<unknown>[] = [];
  readonly #steps: FakeDecisionStep[];
  readonly #options: FakeDecisionAdapterOptions;
  readonly #clock: Clock;

  constructor(options: FakeDecisionAdapterOptions = {}) {
    this.id = options.id ?? "fake";
    this.#steps = [...(options.steps ?? [])];
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
  }

  enqueue(...steps: FakeDecisionStep[]): this {
    this.#steps.push(...steps);
    return this;
  }

  get pendingSteps(): number {
    return this.#steps.length;
  }

  estimateCostCents(): number {
    return this.#options.estimateCostCents ?? 0;
  }

  decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    this.calls.push(request);
    return executeProviderCall(
      request,
      {
        providerId: this.id,
        clock: this.#clock,
        logger: this.#options.logger,
        estimateCostCents: this.estimateCostCents(),
      },
      async ({ signal }) => {
        this.invocations.push(request);
        const step = this.#steps.shift() ?? this.#options.fallback;
        if (!step) {
          throw decisionError("PROVIDER_ERROR", "provider_error", `Fake "${this.id}" script is exhausted`, {
            retryable: false,
          });
        }
        if (step.delayMs) await abortableSleep(step.delayMs, signal);
        if ("error" in step) throw step.error;
        return {
          raw: step.output,
          encoding: "value",
          model: step.model ?? this.#options.model ?? "fake-model",
          usage: step.usage ?? ZERO_USAGE,
          costCents: step.costCents ?? 0,
        };
      },
    );
  }
}
