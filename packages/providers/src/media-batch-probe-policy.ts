import {
  MediaFailedAfterSpend,
  type MediaGenerationRequest,
  type MediaGenerationResult,
  type MediaProvider,
  type TenantContext,
} from "@studix/core";
import { type Clock, StudixError, systemClock } from "@studix/shared";
import { centsFromPrice, type MediaPriceBook, mediaBillingQuantity } from "./media-price-book.ts";

/** A model's first real cost may exceed its estimate by this share before the batch stops for review. */
export const DEFAULT_PROBE_OVERRUN_TOLERANCE = 0.2;

export interface ProbeBeforeBatchOptions {
  priceBook: MediaPriceBook;
  /** Cap for the whole batch, probes included. */
  budgetCents: number;
  overrunTolerance?: number;
  /**
   * Model key a request will run on; must match the `model` the provider reports in results so prices
   * recorded from receipts are found again (MultixProvider.resolveModel does this for Multix).
   */
  resolveModel?: (request: MediaGenerationRequest) => string;
  clock?: Clock;
}

export type MediaBatchStopReason =
  /** The probe ran but the provider reported no charge, so the model's price is still unproven. */
  | "probe_unpriced"
  /** The probe cost more than its estimate plus the tolerance. */
  | "probe_overrun"
  /** The next step would take the batch over its budget. */
  | "budget_exceeded";

export type MediaBatchOutcome =
  | { status: "completed"; results: MediaGenerationResult[]; spentCents: number }
  | {
      status: "stopped";
      reason: MediaBatchStopReason;
      model: string;
      message: string;
      /** Aligned with the requests; null for the ones that did not run. */
      results: (MediaGenerationResult | null)[];
      spentCents: number;
      details: Record<string, unknown>;
    };

class BatchStop extends Error {
  constructor(
    readonly reason: MediaBatchStopReason,
    readonly model: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Billing policy for paid media batches: a model without a measured price runs one job first (the probe),
 * its receipt becomes the model's price, and only then does the rest of the batch run, re-estimated with
 * that price and checked against the budget. Catalog prices alone are not trusted: they have been wrong by
 * an order of magnitude. The policy stops (and returns what already ran) instead of overspending.
 */
export async function runMediaBatchWithProbe(
  ctx: TenantContext,
  provider: MediaProvider,
  requests: readonly MediaGenerationRequest[],
  options: ProbeBeforeBatchOptions,
): Promise<MediaBatchOutcome> {
  if (!Number.isInteger(options.budgetCents) || options.budgetCents < 0) {
    throw new StudixError("VALIDATION", "budgetCents must be a non-negative integer");
  }
  const tolerance = options.overrunTolerance ?? DEFAULT_PROBE_OVERRUN_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new StudixError("VALIDATION", "overrunTolerance must be a non-negative number");
  }
  const clock = options.clock ?? systemClock;
  const resolveModel =
    options.resolveModel ??
    ((r: MediaGenerationRequest) => `${provider.id}:${r.kind}:${r.model ?? "default"}`);

  const results: (MediaGenerationResult | null)[] = requests.map(() => null);
  let spent = 0;
  const groups = new Map<string, number[]>();
  requests.forEach((request, index) => {
    const model = resolveModel(request);
    groups.set(model, [...(groups.get(model) ?? []), index]);
  });

  const run = async (index: number): Promise<MediaGenerationResult> => {
    let result: MediaGenerationResult;
    try {
      result = await provider.generate(ctx, requests[index]!);
    } catch (err) {
      if (err instanceof MediaFailedAfterSpend) spent += err.charge.costCents;
      throw err;
    }
    results[index] = result;
    spent += result.costCents;
    return result;
  };

  try {
    for (const [model, indexes] of groups) {
      let rest = indexes;
      let price = await options.priceBook.get(model);
      if (!price) {
        const [probeIndex, ...others] = indexes as [number, ...number[]];
        const probe = requests[probeIndex]!;
        const estimate = await provider.estimateCostCents(probe);
        if (spent + estimate > options.budgetCents) {
          throw new BatchStop("budget_exceeded", model, `Probing ${model} would exceed the batch budget`, {
            estimateCents: estimate,
            spentCents: spent,
            budgetCents: options.budgetCents,
          });
        }
        const result = await run(probeIndex);
        if (result.costSource !== "receipt") {
          throw new BatchStop(
            "probe_unpriced",
            model,
            `The probe job on ${model} reported no charge, so its price is unproven`,
            { estimateCents: estimate, costCents: result.costCents, remaining: others.length },
          );
        }
        const { unit, quantity } = mediaBillingQuantity(probe);
        price = {
          model,
          unit,
          centsPerUnit: result.costCents / quantity,
          basis: "measured",
          sampleCents: result.costCents,
          sampleQuantity: quantity,
          recordedAt: clock.now().toISOString(),
        };
        await options.priceBook.record(price);
        if (result.costCents > estimate * (1 + tolerance)) {
          throw new BatchStop(
            "probe_overrun",
            model,
            `The probe job on ${model} cost ${result.costCents}¢ against an estimate of ${estimate}¢`,
            { estimateCents: estimate, costCents: result.costCents, tolerance, remaining: others.length },
          );
        }
        rest = others;
      }
      const priced = price;
      const estimates = await Promise.all(
        rest.map(async (i) =>
          Math.max(await provider.estimateCostCents(requests[i]!), centsFromPrice(priced, requests[i]!)),
        ),
      );
      const planned = estimates.reduce((a, b) => a + b, 0);
      if (spent + planned > options.budgetCents) {
        throw new BatchStop("budget_exceeded", model, `The ${model} batch would exceed its budget`, {
          plannedCents: planned,
          spentCents: spent,
          budgetCents: options.budgetCents,
          remaining: rest.length,
        });
      }
      for (const i of rest) await run(i);
    }
  } catch (err) {
    if (!(err instanceof BatchStop)) throw err;
    return {
      status: "stopped",
      reason: err.reason,
      model: err.model,
      message: err.message,
      results,
      spentCents: spent,
      details: err.details,
    };
  }
  return { status: "completed", results: results as MediaGenerationResult[], spentCents: spent };
}
