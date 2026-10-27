import type { MediaCapability, MediaKind, MediaProvider } from "@studix/core";
import { StudixError } from "@studix/shared";
import { assertMediaKind } from "./media-request-guards.ts";

export interface MediaProviderSelection {
  kind: MediaKind;
  /** Require a provider that lists this model for the kind. */
  model?: string;
  /** Pin a provider by id; it still has to support the kind (and model). */
  providerId?: string;
}

export interface CapableProvider {
  provider: MediaProvider;
  capability: MediaCapability;
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Registered MediaProviders, selected by capability. Registration order is the preference order, and a
 * missing capability fails with a typed error instead of degrading to another kind or model.
 */
export class MediaProviderRegistry {
  private readonly providers = new Map<string, MediaProvider>();

  constructor(providers: readonly MediaProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: MediaProvider): this {
    if (!PROVIDER_ID.test(provider.id)) {
      throw new StudixError("VALIDATION", `Invalid media provider id ${JSON.stringify(provider.id)}`);
    }
    if (this.providers.has(provider.id)) {
      throw new StudixError("CONFLICT", `Media provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): MediaProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new StudixError("NOT_FOUND", `Unknown media provider "${id}"`);
    return provider;
  }

  list(): MediaProvider[] {
    return [...this.providers.values()];
  }

  /** Providers that can serve the kind (and model), in preference order. */
  async capable(kind: MediaKind, model?: string): Promise<CapableProvider[]> {
    assertMediaKind(kind);
    const found: CapableProvider[] = [];
    for (const provider of this.providers.values()) {
      const capability = (await provider.capabilities()).find(
        (c) => c.kind === kind && (model === undefined || c.models.includes(model)),
      );
      if (capability) found.push({ provider, capability });
    }
    return found;
  }

  async select(selection: MediaProviderSelection): Promise<MediaProvider> {
    const candidates = await this.capable(selection.kind, selection.model);
    const wanted = selection.model ? `${selection.kind} (model ${selection.model})` : selection.kind;
    if (selection.providerId !== undefined) {
      const pinned = this.get(selection.providerId);
      if (!candidates.some((c) => c.provider === pinned)) {
        throw new StudixError("UNAVAILABLE", `Media provider "${pinned.id}" cannot generate ${wanted}`, {
          retryable: false,
          details: { providerId: pinned.id, kind: selection.kind, model: selection.model },
        });
      }
      return pinned;
    }
    const first = candidates[0];
    if (!first) {
      throw new StudixError("UNAVAILABLE", `No configured media provider can generate ${wanted}`, {
        retryable: false,
        suggestedAction: "Configure a provider for this capability or change the request.",
        details: { kind: selection.kind, model: selection.model, registered: [...this.providers.keys()] },
      });
    }
    return first.provider;
  }
}
