import { type Clock, type Logger, StudixError } from "@studix/shared";
import { z } from "zod";
import { OPENROUTER_DEFAULT_BASE_URL, OpenRouterAdapter } from "./adapters/openrouter-adapter.ts";
import { RulesAdapter } from "./adapters/rules-adapter.ts";
import {
  TYPESAFE_DEFAULT_BASE_URL,
  TYPESAFE_DEFAULT_MODEL,
  TypeSafeAIAdapter,
} from "./adapters/typesafe-ai-adapter.ts";
import type { TypeSafeQuestionMapper } from "./adapters/typesafe-question-mapping.ts";
import type { DecisionProvider } from "./decision-types.ts";
import type { FetchLike } from "./http-json-client.ts";
import { DecisionRouter, type DecisionRouterOptions } from "./router/decision-router.ts";
import type { ProviderExecutionSink } from "./router/provider-execution-sink.ts";

/** Provider ids selectable from configuration. */
export const CONFIGURABLE_DECISION_PROVIDERS = ["typesafe", "openrouter", "rules"] as const;
type ConfigurableProvider = (typeof CONFIGURABLE_DECISION_PROVIDERS)[number];

/** Environment variables read by createDecisionRouterFromConfig (values are never logged or echoed). */
export const DECISION_ENV_VARS = [
  "DECISION_PROVIDERS",
  "DECISION_ROUTES",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_DECISION_MODEL",
  "OPENROUTER_INPUT_CENTS_PER_MTOK",
  "OPENROUTER_OUTPUT_CENTS_PER_MTOK",
  "TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "TYPESAFE_DECISION_MODEL",
  "TYPESAFE_INPUT_CENTS_PER_MTOK",
] as const;

const providerId = z.enum(CONFIGURABLE_DECISION_PROVIDERS);
const chain = z
  .string()
  .transform((v) =>
    v
      .split(/[,>]/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(providerId).min(1));
const cents = z.coerce.number().finite().min(0).optional();

const DecisionEnvSchema = z.object({
  /** Default chain for every kind without an explicit route, in priority order (comma or `>`). */
  DECISION_PROVIDERS: chain.default(["rules"]),
  /** Per-kind chains: `video.plan=typesafe>openrouter>rules;qa.route=openrouter`. */
  DECISION_ROUTES: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.url().default(OPENROUTER_DEFAULT_BASE_URL),
  OPENROUTER_DECISION_MODEL: z.string().optional(),
  OPENROUTER_INPUT_CENTS_PER_MTOK: cents,
  OPENROUTER_OUTPUT_CENTS_PER_MTOK: cents,
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_BASE_URL: z.url().default(TYPESAFE_DEFAULT_BASE_URL),
  TYPESAFE_DECISION_MODEL: z.string().default(TYPESAFE_DEFAULT_MODEL),
  TYPESAFE_INPUT_CENTS_PER_MTOK: cents,
});

export interface DecisionRouterDependencies {
  /** Rules registry used when `rules` is in a chain; register deterministic planners on it. */
  rules?: RulesAdapter;
  typesafeMappers?: Record<string, TypeSafeQuestionMapper>;
  sink?: ProviderExecutionSink;
  clock?: Clock;
  logger?: Logger;
  fetch?: FetchLike;
  router?: Pick<
    DecisionRouterOptions,
    "maxAttemptsPerProvider" | "retryBackoffMs" | "circuitBreaker" | "idempotency"
  >;
}

function configError(message: string, variables: string[]): StudixError {
  return new StudixError("VALIDATION", `Invalid decision configuration: ${message}`, {
    details: { variables },
    suggestedAction: "Fix the listed environment variables; see .env.example.",
  });
}

function parseRoutes(raw: string | undefined): Record<string, ConfigurableProvider[]> {
  const routes: Record<string, ConfigurableProvider[]> = {};
  for (const entry of (raw ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [kind, value, extra] = entry.split("=").map((s) => s.trim());
    const parsed = chain.safeParse(value ?? "");
    if (!kind || extra !== undefined || !parsed.success) {
      throw configError(`DECISION_ROUTES entry "${kind ?? ""}" must look like kind=provider>provider`, [
        "DECISION_ROUTES",
      ]);
    }
    routes[kind] = parsed.data;
  }
  return routes;
}

/**
 * Build the production DecisionRouter from environment variables (see DECISION_ENV_VARS). Only
 * providers referenced by a chain are constructed; a referenced provider without credentials or a model
 * is a boot-time VALIDATION error rather than a silent skip.
 */
export function createDecisionRouterFromConfig(
  env: NodeJS.ProcessEnv = process.env,
  deps: DecisionRouterDependencies = {},
): DecisionRouter {
  const cleaned: Record<string, string> = {};
  for (const name of DECISION_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) cleaned[name] = value;
  }
  const parsed = DecisionEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const variables = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw configError(variables.join(", "), variables);
  }
  const cfg = parsed.data;
  const routes = parseRoutes(cfg.DECISION_ROUTES);
  const used = new Set<ConfigurableProvider>([...cfg.DECISION_PROVIDERS, ...Object.values(routes).flat()]);
  const common = { clock: deps.clock, logger: deps.logger, fetch: deps.fetch };
  const providers: DecisionProvider[] = [];

  if (used.has("openrouter")) {
    if (!cfg.OPENROUTER_API_KEY || !cfg.OPENROUTER_DECISION_MODEL) {
      throw configError("openrouter needs an API key and a decision model", [
        "OPENROUTER_API_KEY",
        "OPENROUTER_DECISION_MODEL",
      ]);
    }
    const priced =
      cfg.OPENROUTER_INPUT_CENTS_PER_MTOK !== undefined || cfg.OPENROUTER_OUTPUT_CENTS_PER_MTOK !== undefined;
    providers.push(
      new OpenRouterAdapter({
        ...common,
        apiKey: cfg.OPENROUTER_API_KEY,
        baseUrl: cfg.OPENROUTER_BASE_URL,
        model: cfg.OPENROUTER_DECISION_MODEL,
        appName: "Studix",
        ...(priced
          ? {
              pricing: {
                inputCentsPerMillionTokens: cfg.OPENROUTER_INPUT_CENTS_PER_MTOK ?? 0,
                outputCentsPerMillionTokens: cfg.OPENROUTER_OUTPUT_CENTS_PER_MTOK ?? 0,
              },
            }
          : {}),
      }),
    );
  }
  if (used.has("typesafe")) {
    if (!cfg.TYPESAFE_API_KEY) throw configError("typesafe needs an API key", ["TYPESAFE_API_KEY"]);
    providers.push(
      new TypeSafeAIAdapter({
        ...common,
        apiKey: cfg.TYPESAFE_API_KEY,
        baseUrl: cfg.TYPESAFE_BASE_URL,
        model: cfg.TYPESAFE_DECISION_MODEL,
        mappers: deps.typesafeMappers,
        ...(cfg.TYPESAFE_INPUT_CENTS_PER_MTOK !== undefined
          ? {
              pricing: {
                inputCentsPerMillionTokens: cfg.TYPESAFE_INPUT_CENTS_PER_MTOK,
                outputCentsPerMillionTokens: 0,
              },
            }
          : {}),
      }),
    );
  }
  if (used.has("rules"))
    providers.push(deps.rules ?? new RulesAdapter({ clock: deps.clock, logger: deps.logger }));

  return new DecisionRouter({
    ...deps.router,
    providers,
    routes,
    defaultRoute: cfg.DECISION_PROVIDERS,
    sink: deps.sink,
    clock: deps.clock,
    logger: deps.logger,
  });
}
