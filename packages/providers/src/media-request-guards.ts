import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
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

/** Input media for image-to-video, lip-sync and upscale: a file inside workDir or an https URL. */
export type MediaInput = { kind: "file"; path: string } | { kind: "url"; url: string };

const MAX_URL_LENGTH = 2048;

/**
 * Validate `params[name]`. Local files must resolve (symlinks included) inside workDir, so a request can
 * never make a provider upload an arbitrary worker file.
 */
export async function resolveMediaInput(
  params: Record<string, unknown>,
  name: string,
  workDir: string,
): Promise<MediaInput | undefined> {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || /[\r\n\0]/.test(value)) {
    throw new StudixError("VALIDATION", `params.${name} must be a file path or an https URL`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new StudixError("VALIDATION", `params.${name} is not a valid URL`);
    }
    if (url.protocol !== "https:" || url.username || url.password || value.length > MAX_URL_LENGTH) {
      throw new StudixError("VALIDATION", `params.${name} must be an https URL without credentials`);
    }
    return { kind: "url", url: value };
  }
  if (!isAbsolute(value)) {
    throw new StudixError("VALIDATION", `params.${name} must be an absolute path inside workDir`);
  }
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([realpath(value), realpath(workDir)]);
  } catch (err) {
    throw new StudixError("VALIDATION", `params.${name} does not exist`, { cause: err });
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new StudixError("VALIDATION", `params.${name} must be inside workDir`);
  }
  return { kind: "file", path: real };
}

/** An optional string param that must match `pattern` (keeps argv values to known shapes). */
export function stringParam(
  params: Record<string, unknown>,
  name: string,
  pattern: RegExp,
): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new StudixError("VALIDATION", `params.${name} has an unsupported value`);
  }
  return value;
}

/** An optional number param within min..max. */
export function numberParam(
  params: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new StudixError(
      "VALIDATION",
      `params.${name} must be ${integer ? "an integer" : "a number"} in ${min}..${max}`,
    );
  }
  return value;
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
