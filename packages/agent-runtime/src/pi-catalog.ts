import { getModels, getProviders } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { pinnedPiEndpoint } from "./opencode-go-catalog.ts";

/*
 * What the Pi runtime can talk to, derived from the SDK's own catalog so it never drifts from the pinned
 * version. Read-only and offline: nothing here reads credentials, the environment or `~/.pi`.
 */

export interface PiCatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Dollars per million tokens, as published by the SDK catalog. */
  cost: { input: number; output: number };
}

export interface PiCatalogProvider {
  id: string;
  name: string;
  /** Only API keys can be stored; OAuth logins are listed as restricted. */
  authMethods: Array<"api_key">;
  /** Set when the SDK knows an OAuth login that is not offered (ADR 0011, ADR 0016). */
  oauthRestriction?: string;
  models: PiCatalogModel[];
}

/**
 * Providers whose only credential is the API key handed to the session. Anything with ambient auth (cloud
 * IAM, ADC, account ids read from the environment) is left out: the Pi SDK would fall back to the
 * operator's own environment for it, which breaks the per-tenant credential boundary (ADR 0016).
 */
const RUNTIME_KEY_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "groq",
  "mistral",
  "xai",
  "cerebras",
  "deepseek",
  "fireworks",
  "huggingface",
  "zai",
  "moonshotai",
  // OpenCode Go subscription: one key for its OpenAI-compatible endpoint; Studix pins the model list.
  "opencode-go",
]);

/** Display names for providers the SDK only knows by id (it names just the ones with an OAuth login). */
const PROVIDER_NAMES: Readonly<Record<string, string>> = { "opencode-go": "OpenCode Go" };

export function isRuntimeKeyProvider(provider: string): boolean {
  return RUNTIME_KEY_PROVIDERS.has(provider);
}

const OAUTH_RESTRICTION =
  "OAuth sign-in through a third-party harness is not enabled for this provider; connect an API key instead.";

let cached: PiCatalogProvider[] | undefined;

/** The catalog of the pinned SDK version; computed once per process. */
export function listPiCatalog(): PiCatalogProvider[] {
  if (cached) return cached;
  const oauth = new Map(
    AuthStorage.inMemory({})
      .getOAuthProviders()
      .map((p) => [p.id, p.name] as const),
  );
  const sdkProviders = new Set<string>(getProviders());
  cached = [...RUNTIME_KEY_PROVIDERS]
    .filter((id) => sdkProviders.has(id))
    .sort()
    .map((id) => ({
      id,
      name: PROVIDER_NAMES[id] ?? oauth.get(id)?.replace(/\s*\(.*\)$/, "") ?? id,
      authMethods: ["api_key"],
      ...(oauth.has(id) ? { oauthRestriction: OAUTH_RESTRICTION } : {}),
      models: (pinnedPiEndpoint(id)?.models ?? getModels(id as Parameters<typeof getModels>[0])).map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        reasoning: m.reasoning ?? false,
        contextWindow: m.contextWindow ?? 0,
        maxTokens: m.maxTokens ?? 0,
        cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
      })),
    }));
  return cached;
}

export function findPiModel(provider: string, modelId: string): PiCatalogModel | undefined {
  return listPiCatalog()
    .find((p) => p.id === provider)
    ?.models.find((m) => m.id === modelId);
}

/** The catalog model with the lowest list price, used for the one-cent key test. */
export function cheapestPiModel(provider: string): PiCatalogModel | undefined {
  const models = listPiCatalog().find((p) => p.id === provider)?.models ?? [];
  return [...models].sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output))[0];
}
