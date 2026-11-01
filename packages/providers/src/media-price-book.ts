import type { MediaGenerationRequest } from "@studix/core";
import { StudixError } from "@studix/shared";

export type MediaBillingUnit = "second" | "character" | "image" | "call";

export interface MediaBillingQuantity {
  unit: MediaBillingUnit;
  quantity: number;
}

type PricedRequest = Pick<MediaGenerationRequest, "kind" | "prompt" | "params">;

/**
 * What a media request is billed by, so one measured job can price the others: seconds when a duration is
 * given, characters for speech, images for image work, otherwise one call.
 */
export function mediaBillingQuantity(request: PricedRequest): MediaBillingQuantity {
  const params = request.params ?? {};
  const durationMs = params.durationMs;
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
    return { unit: "second", quantity: Math.ceil(durationMs / 1000) };
  }
  if (request.kind === "voice") return { unit: "character", quantity: Math.max(1, request.prompt.length) };
  if (request.kind === "image" || (request.kind === "upscale" && params.video === undefined)) {
    const n = params.numImages;
    return { unit: "image", quantity: typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 1 };
  }
  return { unit: "call", quantity: 1 };
}

/**
 * "measured": derived from a provider receipt of a real job. "accepted": entered by a person who approved
 * the price of a model whose receipts carry no amount.
 */
export type MediaPriceBasis = "measured" | "accepted";

export interface MediaPrice {
  /** Model key as resolved by the provider (e.g. "sume:z-image"). */
  model: string;
  unit: MediaBillingUnit;
  centsPerUnit: number;
  basis: MediaPriceBasis;
  /** The observation the price came from. */
  sampleCents: number;
  sampleQuantity: number;
  recordedAt: string;
}

/** Prices proven for a model. Absence means the model is unmeasured and must be probed before a batch. */
export interface MediaPriceBook {
  get(model: string): Promise<MediaPrice | undefined>;
  record(price: MediaPrice): Promise<void>;
}

export function assertMediaPrice(price: MediaPrice): void {
  const ok =
    typeof price.model === "string" &&
    price.model !== "" &&
    Number.isFinite(price.centsPerUnit) &&
    price.centsPerUnit >= 0 &&
    Number.isFinite(price.sampleCents) &&
    price.sampleCents >= 0 &&
    Number.isFinite(price.sampleQuantity) &&
    price.sampleQuantity > 0;
  if (!ok) throw new StudixError("VALIDATION", "A media price needs a model and non-negative amounts");
}

/** Process-local price book; a persistent one belongs with the usage ledger. */
export class InMemoryMediaPriceBook implements MediaPriceBook {
  private readonly prices = new Map<string, MediaPrice>();

  async get(model: string): Promise<MediaPrice | undefined> {
    const price = this.prices.get(model);
    return price ? { ...price } : undefined;
  }

  async record(price: MediaPrice): Promise<void> {
    assertMediaPrice(price);
    this.prices.set(price.model, { ...price });
  }
}

/** Ceiling for one request from a stored price; a price in another unit only vouches for one call. */
export function centsFromPrice(price: MediaPrice, request: PricedRequest): number {
  const { unit, quantity } = mediaBillingQuantity(request);
  if (unit !== price.unit) return price.sampleCents;
  return Math.ceil(price.centsPerUnit * quantity - 1e-9);
}
