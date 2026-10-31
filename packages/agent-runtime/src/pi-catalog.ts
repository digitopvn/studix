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
 * OAuth logins that drive a vendor's consumer subscription through a third-party harness. They stay
 * unavailable until the vendor's terms allow it (ADR 0011); API keys for the same provider are unaffected.
 */
const RESTRICTED_OAUTH: Readonly<Record<string, string>> = {
  anthropic:
    "Claude Pro/Max subscriptions may not be used through third-party harnesses; connect an API key instead.",
};

export function isOAuthRestricted(provider: string): boolean {
  return provider in RESTRICTED_OAUTH;
}

export function listPiCatalog(): PiCatalogProvider[] {
  const oauthIds = new Map(
    AuthStorage.inMemory({})
      .getOAuthProviders()
      .map((p) => [p.id, p.name] as const),
  );
  return [...getProviders()].sort().map((id) => {
    const restriction = RESTRICTED_OAUTH[id];
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
