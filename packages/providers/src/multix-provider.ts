import type {
  MediaCapability,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaKind,
  MediaProvider,
  TenantContext,
} from "@studix/core";
import { type StudixConfig, StudixError } from "@studix/shared";
import { assertEstimateRequest, assertGenerationRequest } from "./media-request-guards.ts";
import { MULTIX_CAPABILITY_CATALOG, type MultixCapabilityInfo } from "./multix-capability-catalog.ts";

export const MULTIX_PROVIDER_ID = "multix";

export interface MultixProviderOptions {
  /** Path or name of the multix CLI (config.MULTIX_BIN). Absent means the provider is disabled. */
  bin?: string;
}

export interface MultixProviderStatus {
  id: string;
  enabled: boolean;
  /** Why generation is unavailable, when it is. */
  reason?: string;
  catalog: readonly MultixCapabilityInfo[];
}

/**
 * Multix adapter shell. It satisfies the MediaProvider contract and carries capability metadata, but it
 * advertises only "wired" capabilities and refuses every call with a typed error until a modality is
 * wired end to end. It never spawns the CLI or reaches the network in this build.
 */
export class MultixProvider implements MediaProvider {
  readonly id = MULTIX_PROVIDER_ID;
  private readonly bin: string | undefined;

  constructor(options: MultixProviderOptions = {}) {
    const bin = options.bin?.trim();
    this.bin = bin ? bin : undefined;
  }

  get enabled(): boolean {
    return this.bin !== undefined;
  }

  status(): MultixProviderStatus {
    return {
      id: this.id,
      enabled: this.enabled,
      ...(this.enabled ? {} : { reason: "MULTIX_BIN is not set" }),
      catalog: MULTIX_CAPABILITY_CATALOG,
    };
  }

  async capabilities(): Promise<MediaCapability[]> {
    if (!this.enabled) return [];
    return MULTIX_CAPABILITY_CATALOG.filter((c) => c.status === "wired").map(
      ({ status: _status, vendors: _vendors, ...capability }) => capability,
    );
  }

  async estimateCostCents(
    request: Omit<MediaGenerationRequest, "workDir" | "signal" | "idempotencyKey">,
  ): Promise<number> {
    assertEstimateRequest(request);
    throw this.unavailable(request.kind);
  }

  async generate(_ctx: TenantContext, request: MediaGenerationRequest): Promise<MediaGenerationResult> {
    assertGenerationRequest(request);
    throw this.unavailable(request.kind);
  }

  private unavailable(kind: MediaKind): StudixError {
    if (!this.enabled) {
      return new StudixError("UNAVAILABLE", "The Multix provider is not configured", {
        retryable: false,
        suggestedAction: "Set MULTIX_BIN to the multix CLI on the worker, or use another provider.",
        details: { provider: this.id },
      });
    }
    const info = MULTIX_CAPABILITY_CATALOG.find((c) => c.kind === kind);
    return new StudixError("UNAVAILABLE", `Multix ${kind} generation is not wired in this build`, {
      retryable: false,
      suggestedAction: "Choose a provider whose capabilities() lists this kind.",
      details: { provider: this.id, kind, status: info?.status ?? "unsupported" },
    });
  }
}

export function createMultixProviderFromConfig(config: Pick<StudixConfig, "MULTIX_BIN">): MultixProvider {
  return new MultixProvider({ bin: config.MULTIX_BIN });
}
