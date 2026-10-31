import { getModels, getProviders } from "@mariozechner/pi-ai";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { ProviderAuthMethod } from "@studix/core";

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
  authMethods: ProviderAuthMethod[];
  /** Set when OAuth exists but must not be offered without an explicit compliance decision. */
  oauthRestriction?: string;
  models: PiCatalogModel[];
}

/**
 * Providers whose only credential is the API key we hand the session. Anything with ambient auth (cloud IAM,
 * ADC, account ids read from the environment) or an unverified vendor is left out: the Pi SDK would fall
 * back to the operator's own environment for it, which breaks the per-tenant credential boundary (ADR 0012).
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
]);

export function isRuntimeKeyProvider(provider: string): boolean {
  return RUNTIME_KEY_PROVIDERS.has(provider);
}

/**
 * OAuth is offered per provider, only after the vendor's terms for third-party harnesses were checked
 * (ADR 0012). Nothing is allowed yet, so every OAuth login the SDK knows about is reported as restricted.
 */
const OAUTH_ALLOWED: ReadonlySet<string> = new Set();

const OAUTH_RESTRICTION =
  "OAuth sign-in through a third-party harness is not enabled for this provider; connect an API key instead.";

export function isOAuthRestricted(provider: string): boolean {
  return !OAUTH_ALLOWED.has(provider);
}

export function listPiCatalog(): PiCatalogProvider[] {
  const oauthIds = new Map(
    AuthStorage.inMemory({})
      .getOAuthProviders()
      .map((p) => [p.id, p.name] as const),
  );
  return [...getProviders()]
    .filter(isRuntimeKeyProvider)
    .sort()
    .map((id) => {
      const restriction = isOAuthRestricted(id) ? OAUTH_RESTRICTION : undefined;
      const hasOAuth = oauthIds.has(id);
      return {
        id,
        name: oauthIds.get(id)?.replace(/\s*\(.*\)$/, "") ?? id,
        authMethods: ["api_key", ...(hasOAuth && !restriction ? (["oauth"] as const) : [])],
        ...(hasOAuth && restriction ? { oauthRestriction: restriction } : {}),
        models: getModels(id as Parameters<typeof getModels>[0]).map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: { input: m.cost.input, output: m.cost.output },
        })),
      };
    });
}

export function findPiModel(provider: string, modelId: string): PiCatalogModel | undefined {
  return listPiCatalog()
    .find((p) => p.id === provider)
    ?.models.find((m) => m.id === modelId);
}
