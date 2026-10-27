import { type Clock, type Logger, systemClock } from "@studix/shared";
import { decisionError } from "../decision-errors.ts";
import { resolveJsonSchema } from "../decision-request-validation.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../decision-types.ts";
import { executeProviderCall, type ProviderInvocation } from "../execute-provider-call.ts";
import { type FetchLike, postJson } from "../http-json-client.ts";
import {
  assertPricing,
  costFromUsage,
  estimateTokens,
  nonNegativeInt,
  type TokenPricing,
} from "../token-pricing.ts";
import { normalizeBaseUrl, requireApiKey, requireModel } from "./adapter-config-validation.ts";
import {
  mapFlatSchemaToQuestions,
  type TypeSafeAnswer,
  type TypeSafeQuestionMapper,
  type TypeSafeQuestionPlan,
} from "./typesafe-question-mapping.ts";

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export interface TypeSafeAIAdapterOptions {
  apiKey: string;
  /** Model name or alias (default `jev-latest`). */
  model?: string;
  modelsByKind?: Record<string, string>;
  baseUrl?: string;
  /** Per-kind question mappers; kinds without one use the flat-schema mapping. */
  mappers?: Record<string, TypeSafeQuestionMapper>;
  /** TypeSafe bills input tokens; output tokens are currently free. No cost is returned by the API. */
  pricing?: TokenPricing;
  id?: string;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, TypeSafeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Jev decisions over TypeSafe's System One HTTP API (`POST /v1/systemone`, bearer auth). */
export class TypeSafeAIAdapter implements DecisionProvider {
  readonly id: string;
  readonly #apiKey: string;
  readonly #options: TypeSafeAIAdapterOptions;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;

  constructor(options: TypeSafeAIAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey, "TypeSafe");
    requireModel(options.model ?? TYPESAFE_DEFAULT_MODEL, "TypeSafe");
    assertPricing(options.pricing, "TypeSafe");
    this.#options = options;
    this.id = options.id ?? "typesafe";
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? TYPESAFE_DEFAULT_BASE_URL, "TypeSafe");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = options.clock ?? systemClock;
  }

  modelFor(kind: string): string {
    return (this.#options.modelsByKind?.[kind] ?? this.#options.model ?? TYPESAFE_DEFAULT_MODEL).trim();
  }

  #plan(request: DecisionRequest<unknown>): TypeSafeQuestionPlan {
    const mapper = this.#options.mappers?.[request.kind] ?? mapFlatSchemaToQuestions;
    return mapper(request, resolveJsonSchema(request));
  }

  estimateCostCents(request: DecisionRequest<unknown>): number {
    if (!this.#options.pricing) return 0;
    let plan: TypeSafeQuestionPlan;
    try {
      plan = this.#plan(request);
    } catch {
      return 0; // Unmappable decisions fail fast in decide() without spending anything.
    }
    const prompt = JSON.stringify({ state: plan.state, questions: plan.questions });
    return costFromUsage({ inputTokens: estimateTokens(prompt), outputTokens: 0 }, this.#options.pricing);
  }

  decide<T>(request: DecisionRequest<T>): Promise<DecisionResult<T>> {
    return executeProviderCall(
      request,
      {
        providerId: this.id,
        clock: this.#clock,
        logger: this.#options.logger,
        estimateCostCents: this.estimateCostCents(request),
      },
      ({ signal }) => this.#invoke(request, signal),
    );
  }

  async #invoke(request: DecisionRequest<unknown>, signal: AbortSignal): Promise<ProviderInvocation> {
    const plan = this.#plan(request);
    const model = this.modelFor(request.kind);
    const body = (await postJson({
      provider: "TypeSafe",
      url: `${this.#baseUrl}/systemone`,
      apiKey: this.#apiKey,
      signal,
      fetch: this.#fetch,
      body: { model, state: plan.state, questions: plan.questions },
    })) as SystemOneResponse;
    const usage = {
      inputTokens: nonNegativeInt(body.usage?.input_tokens),
      outputTokens: nonNegativeInt(body.usage?.output_tokens),
    };
    const costCents = costFromUsage(usage, this.#options.pricing);
    const answeredModel = typeof body.model === "string" && body.model ? body.model : model;
    if (!body.answers || typeof body.answers !== "object") {
      throw decisionError("PROVIDER_ERROR", "schema_invalid", "TypeSafe response has no answers", {
        costCents,
        usage,
        model: answeredModel,
      });
    }
    return { raw: plan.toOutput(body.answers), encoding: "value", model: answeredModel, usage, costCents };
  }
}
