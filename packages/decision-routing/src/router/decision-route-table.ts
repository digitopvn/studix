import { StudixError } from "@studix/shared";
import { RulesAdapter } from "../adapters/rules-adapter.ts";
import type { DecisionProvider } from "../decision-types.ts";

/** Ordered provider ids tried for a decision kind, e.g. `["typesafe", "openrouter", "rules"]`. */
export type DecisionRoute = readonly string[];

/**
 * Decisions in these namespaces affect security, cost, publishing or approval. They fail closed: a
 * deterministic rules provider may never stand in for a model decision, and no valid decision = deny.
 */
export const DEFAULT_FAIL_CLOSED_PREFIXES = ["security.", "cost.", "publish.", "approval."] as const;

export interface RouteTableOptions {
  providers: readonly DecisionProvider[];
  /** Explicit chain per decision kind. */
  routes?: Record<string, DecisionRoute>;
  /** Chain for kinds without an explicit route. Without one, unrouted kinds are refused. */
  defaultRoute?: DecisionRoute;
  failClosedPrefixes?: readonly string[];
}

function configError(message: string): StudixError {
  return new StudixError("VALIDATION", `Invalid decision routing config: ${message}`, {
    suggestedAction: "Fix DECISION_PROVIDERS / DECISION_ROUTES or the router options.",
  });
}

/** Resolves provider chains per kind; validated once at construction so bad config fails at boot. */
export class DecisionRouteTable {
  readonly #providers = new Map<string, DecisionProvider>();
  readonly #routes = new Map<string, DecisionProvider[]>();
  readonly #defaultRoute?: DecisionProvider[];
  readonly #failClosedPrefixes: readonly string[];

  constructor(options: RouteTableOptions) {
    for (const provider of options.providers) {
      if (!provider?.id) throw configError("every provider needs an id");
      if (this.#providers.has(provider.id)) throw configError(`duplicate provider id "${provider.id}"`);
      this.#providers.set(provider.id, provider);
    }
    this.#failClosedPrefixes = options.failClosedPrefixes ?? DEFAULT_FAIL_CLOSED_PREFIXES;
    for (const [kind, route] of Object.entries(options.routes ?? {})) {
      const chain = this.#resolve(route, `route "${kind}"`);
      if (this.isFailClosed(kind) && chain.some((p) => p instanceof RulesAdapter)) {
        throw configError(`"${kind}" is fail-closed and may not fall back to rules`);
      }
      this.#routes.set(kind, chain);
    }
    if (options.defaultRoute) this.#defaultRoute = this.#resolve(options.defaultRoute, "default route");
  }

  #resolve(route: DecisionRoute, label: string): DecisionProvider[] {
    if (!Array.isArray(route) || route.length === 0) throw configError(`${label} is empty`);
    if (new Set(route).size !== route.length) throw configError(`${label} lists a provider twice`);
    return route.map((id) => {
      const provider = this.#providers.get(id);
      if (!provider) throw configError(`${label} references unknown provider "${id}"`);
      return provider;
    });
  }

  isFailClosed(kind: string): boolean {
    return this.#failClosedPrefixes.some((prefix) => kind.startsWith(prefix));
  }

  /** Provider chain for a kind. Fail-closed kinds never receive rules providers from the default route. */
  chainFor(kind: string): DecisionProvider[] {
    const explicit = this.#routes.get(kind);
    if (explicit) return explicit;
    const fallback = this.#defaultRoute ?? [];
    const chain = this.isFailClosed(kind) ? fallback.filter((p) => !(p instanceof RulesAdapter)) : fallback;
    if (chain.length === 0) {
      throw new StudixError("UNAVAILABLE", `No decision provider is configured for "${kind}"`, {
        retryable: false,
        details: { kind },
        suggestedAction: "Configure a route for this decision kind.",
      });
    }
    return chain;
  }

  providerIds(): string[] {
    return [...this.#providers.keys()];
  }
}
