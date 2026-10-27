import { isAbsolute } from "node:path";
import { MEDIA_KINDS, type MediaGenerationRequest, type MediaKind } from "@studix/core";
import { StudixError } from "@studix/shared";

type EstimateRequest = Omit<MediaGenerationRequest, "workDir" | "signal" | "idempotencyKey">;

/** Prompts are model input, not file content; the cap keeps a runaway caller from building huge argv/logs. */
export const MAX_PROMPT_LENGTH = 4000;

export function assertMediaKind(kind: unknown): asserts kind is MediaKind {
  if (typeof kind !== "string" || !(MEDIA_KINDS as readonly string[]).includes(kind)) {
    throw new StudixError("VALIDATION", `Unknown media kind ${JSON.stringify(kind)}`, {
      details: { allowed: MEDIA_KINDS },
    });
  }
}

/** Boundary checks shared by every provider for the fields a cost estimate depends on. */
export function assertEstimateRequest(request: EstimateRequest): void {
  assertMediaKind(request.kind);
  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw new StudixError("VALIDATION", "A media request needs a non-empty prompt");
  }
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new StudixError("VALIDATION", `Prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
  }
  if (request.params !== undefined && (typeof request.params !== "object" || request.params === null)) {
    throw new StudixError("VALIDATION", "params must be an object");
  }
}

/** Full-request checks: budget cap, idempotency key and an absolute output directory. */
export function assertGenerationRequest(request: MediaGenerationRequest): void {
  assertEstimateRequest(request);
  if (!Number.isInteger(request.maxCostCents) || request.maxCostCents < 0) {
    throw new StudixError("VALIDATION", "maxCostCents must be a non-negative integer");
  }
  if (typeof request.idempotencyKey !== "string" || request.idempotencyKey.trim() === "") {
    throw new StudixError("VALIDATION", "A media request needs an idempotencyKey");
  }
  if (typeof request.workDir !== "string" || !isAbsolute(request.workDir)) {
    throw new StudixError("VALIDATION", "workDir must be an absolute path");
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StudixError("CANCELLED", "Media generation cancelled");
}

/** Providers must refuse rather than exceed the per-call cap. */
export function assertWithinBudget(costCents: number, maxCostCents: number, providerId: string): void {
  if (costCents > maxCostCents) {
    throw new StudixError(
      "BUDGET_EXCEEDED",
      `${providerId} estimates ${costCents} cents, above the ${maxCostCents} cent cap`,
      { details: { costCents, maxCostCents }, suggestedAction: "Raise the cap or choose a cheaper model." },
    );
  }
}
