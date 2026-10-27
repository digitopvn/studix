import { type Clock, type Logger, StudixError, systemClock } from "@studix/shared";
import { decisionError } from "../decision-errors.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../decision-types.ts";
import { executeProviderCall, ZERO_USAGE } from "../execute-provider-call.ts";

export const RULES_MODEL = "rules";

export interface DecisionRuleContext {
  request: DecisionRequest<unknown>;
  /** Aborts on cancellation or deadline; long-running rules should check it. */
  signal: AbortSignal;
}

/** Deterministic decision function. Its return value is validated against the request schema. */
export type DecisionRule = (input: unknown, context: DecisionRuleContext) => unknown;

export interface RulesAdapterOptions {
  id?: string;
  rules?: Record<string, DecisionRule>;
  clock?: Clock;
  logger?: Logger;
}

/**
 * Deterministic fallback provider: a registry of rule functions per decision kind (for example the
 * brand-intro planner for `video.plan`). Free, offline and reproducible. Kinds without a rule are
 * refused as `unsupported`, so a decision can never be answered by a rule nobody registered.
 */
export class RulesAdapter implements DecisionProvider {
  readonly id: string;
  readonly #rules = new Map<string, DecisionRule>();
  readonly #clock: Clock;
  readonly #logger?: Logger;

  constructor(options: RulesAdapterOptions = {}) {
    this.id = options.id ?? "rules";
    this.#clock = options.clock ?? systemClock;
    this.#logger = options.logger;
    for (const [kind, rule] of Object.entries(options.rules ?? {})) this.register(kind, rule);
  }

  /** Register the rule for a decision kind. Re-registering a kind is a CONFLICT (no silent override). */
  register(kind: string, rule: DecisionRule): this {
    if (typeof rule !== "function")
      throw new StudixError("VALIDATION", `Rule for "${kind}" is not a function`);
    if (this.#rules.has(kind)) {
      throw new StudixError("CONFLICT", `A rule is already registered for decision kind "${kind}"`);
    }
    this.#rules.set(kind, rule);
    return this;
  }

  has(kind: string): boolean {
    return this.#rules.has(kind);
  }

  kinds(): string[] {
    return [...this.#rules.keys()];
  }

  estimateCostCents(): number {
    return 0;
  }

  decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    return executeProviderCall(
      request,
      { providerId: this.id, clock: this.#clock, logger: this.#logger, estimateCostCents: 0 },
      async ({ signal }) => {
        const rule = this.#rules.get(request.kind);
        if (!rule) {
          throw decisionError("PROVIDER_ERROR", "unsupported", `No rule registered for "${request.kind}"`, {
            retryable: false,
          });
        }
        const raw = await rule(request.input, { request, signal });
        return { raw, encoding: "value", model: RULES_MODEL, usage: ZERO_USAGE, costCents: 0 };
      },
    );
  }
}
