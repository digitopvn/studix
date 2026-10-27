import { type Clock, type Logger, systemClock } from "@studix/shared";
import { decisionError } from "../decision-errors.ts";
import { resolveJsonSchema } from "../decision-request-validation.ts";
import type { DecisionProvider, DecisionRequest, DecisionResult, JsonSchema } from "../decision-types.ts";
import { executeProviderCall, type ProviderInvocation } from "../execute-provider-call.ts";
import { type FetchLike, httpStatusError, postJson } from "../http-json-client.ts";
import {
  assertPricing,
  costFromUsage,
  estimateTokens,
  nonNegativeInt,
  type TokenPricing,
} from "../token-pricing.ts";
import { normalizeBaseUrl, positiveInt, requireApiKey, requireModel } from "./adapter-config-validation.ts";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterAdapterOptions {
  apiKey: string;
  /** Default model id (e.g. `openai/gpt-4o-mini`). */
  model: string;
  /** Per-kind model overrides. */
  modelsByKind?: Record<string, string>;
  baseUrl?: string;
  /** Cap on completion tokens; also bounds the pre-call cost estimate. Default 1024. */
  maxOutputTokens?: number;
  /** Used for the pre-call estimate and when OpenRouter omits `usage.cost`. */
  pricing?: TokenPricing;
  /** Send `strict: true` with the JSON schema (requires all-required, closed object schemas). */
  strictSchema?: boolean;
  /** Optional OpenRouter app attribution headers. */
  appName?: string;
  appUrl?: string;
  id?: string;
  fetch?: FetchLike;
  clock?: Clock;
  logger?: Logger;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: number | string; message?: string };
}

/** Jev decisions over OpenRouter's OpenAI-compatible chat completions with JSON-schema structured output. */
export class OpenRouterAdapter implements DecisionProvider {
  readonly id: string;
  readonly #apiKey: string;
  readonly #options: OpenRouterAdapterOptions;
  readonly #baseUrl: string;
  readonly #maxOutputTokens: number;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;

  constructor(options: OpenRouterAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey, "OpenRouter");
    requireModel(options.model, "OpenRouter");
    assertPricing(options.pricing, "OpenRouter");
    this.#options = options;
    this.id = options.id ?? "openrouter";
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL, "OpenRouter");
    this.#maxOutputTokens = positiveInt(options.maxOutputTokens, 1024, "maxOutputTokens");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = options.clock ?? systemClock;
  }

  modelFor(kind: string): string {
    return (this.#options.modelsByKind?.[kind] ?? this.#options.model).trim();
  }

  #messages(request: DecisionRequest<unknown>) {
    const system = [
      `You are Jev, a decision engine. Make the "${request.kind}" decision.`,
      request.instructions ?? "",
      "Respond with a single JSON object that matches the provided JSON schema. No prose.",
    ]
      .filter(Boolean)
      .join("\n");
    return [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ input: request.input }) },
    ];
  }

  estimateCostCents(request: DecisionRequest<unknown>): number {
    if (!this.#options.pricing) return 0;
    const prompt = JSON.stringify(this.#messages(request)) + JSON.stringify(resolveJsonSchema(request));
    return costFromUsage(
      { inputTokens: estimateTokens(prompt), outputTokens: this.#maxOutputTokens },
      this.#options.pricing,
    );
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
      ({ signal, jsonSchema }) => this.#invoke(request, jsonSchema, signal),
    );
  }

  async #invoke(
    request: DecisionRequest<unknown>,
    jsonSchema: JsonSchema,
    signal: AbortSignal,
  ): Promise<ProviderInvocation> {
    const model = this.modelFor(request.kind);
    const { $schema: _dialect, ...schema } = jsonSchema;
    const headers: Record<string, string> = {};
    if (this.#options.appName) headers["x-title"] = this.#options.appName;
    if (this.#options.appUrl) headers["http-referer"] = this.#options.appUrl;
    const body = (await postJson({
      provider: "OpenRouter",
      url: `${this.#baseUrl}/chat/completions`,
      apiKey: this.#apiKey,
      headers,
      signal,
      fetch: this.#fetch,
      body: {
        model,
        messages: this.#messages(request),
        temperature: 0,
        max_tokens: this.#maxOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.kind.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
            strict: this.#options.strictSchema ?? false,
            schema,
          },
        },
        // Only route to upstream providers that honor response_format.
        provider: { require_parameters: true },
        usage: { include: true },
      },
    })) as ChatCompletionResponse;

    const usage = {
      inputTokens: nonNegativeInt(body.usage?.prompt_tokens),
      outputTokens: nonNegativeInt(body.usage?.completion_tokens),
    };
    const reportedCost = body.usage?.cost;
    const costCents =
      typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0
        ? reportedCost * 100 // OpenRouter reports cost in USD credits.
        : costFromUsage(usage, this.#options.pricing);
    const answeredModel = typeof body.model === "string" && body.model ? body.model : model;
    const spend = { costCents, usage, model: answeredModel };

    if (body.error) {
      // Mid-stream upstream failures arrive as HTTP 200 with an `error` object carrying a status code.
      const code = body.error.code;
      if (typeof code === "number" && code >= 400 && code <= 599) {
        throw httpStatusError("OpenRouter", new Response(null, { status: code }), JSON.stringify(body));
      }
      throw decisionError(
        "UNAVAILABLE",
        "unavailable",
        `OpenRouter error: ${body.error.message ?? "unknown"}`,
        {
          details: { providerCode: body.error.code },
          ...spend,
        },
      );
    }
    const message = body.choices?.[0]?.message;
    if (message?.refusal) {
      throw decisionError("PROVIDER_ERROR", "schema_invalid", "Model refused to produce the decision", {
        retryable: false,
        ...spend,
      });
    }
    if (typeof message?.content !== "string" || message.content.trim() === "") {
      throw decisionError("PROVIDER_ERROR", "schema_invalid", "OpenRouter returned no message content", {
        retryable: true,
        details: { finishReason: body.choices?.[0]?.finish_reason },
        ...spend,
      });
    }
    return {
      raw: stripCodeFence(message.content),
      encoding: "json-text",
      model: answeredModel,
      usage,
      costCents,
    };
  }
}

/** Some models wrap JSON in a markdown fence despite response_format; unwrap before parsing. */
function stripCodeFence(content: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return match ? match[1]! : content;
}
