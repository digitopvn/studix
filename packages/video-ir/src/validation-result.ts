import { StudixError, toPointer } from "@studix/shared";
import type { z } from "zod";

export type ValidationIssueCode =
  | "schema"
  | "duplicate_id"
  | "unknown_reference"
  | "wrong_asset_kind"
  | "out_of_bounds"
  | "timeline"
  | "unpinned_code"
  | "cycle"
  | "unsupported_version"
  /** A shot hands on state its successor contradicts, or conditions on a stale reference. */
  | "continuity"
  /** Lipsync routing disagrees with who speaks on screen. */
  | "lipsync"
  /** Adjacent scenes break the camera grammar (same move twice, a match cut without motifs). */
  | "camera"
  /** A prerequisite of the requested production phase is missing. */
  | "not_ready"
  /** An html shot's markup fails lintHeroHtml. */
  | "hero_html";

/** One problem, addressed by RFC 6901 JSON pointer into the validated document. */
export interface ValidationIssue {
  path: string;
  code: ValidationIssueCode;
  /** The zod issue code behind a `schema` issue, e.g. `too_big`. */
  constraint?: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export { toPointer };

export function fromZodIssues(issues: ReadonlyArray<z.core.$ZodIssue>): ValidationIssue[] {
  return issues.map((issue) => ({
    path: toPointer(issue.path),
    code: "schema",
    constraint: issue.code,
    message: issue.message,
  }));
}

/** Parse with a schema and return structured issues instead of throwing. */
export function safeValidate<S extends z.ZodType>(schema: S, input: unknown): ValidationResult<z.output<S>> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: fromZodIssues(parsed.error.issues) };
}

/** Unwrap a result or throw a VALIDATION StudixError carrying the issues. */
export function unwrapValidation<T>(result: ValidationResult<T>, what: string): T {
  if (result.ok) return result.value;
  const head = result.issues
    .slice(0, 3)
    .map((i) => `${i.path || "/"}: ${i.message}`)
    .join("; ");
  throw new StudixError("VALIDATION", `Invalid ${what}: ${head}`, {
    details: { issues: result.issues },
    suggestedAction: `Fix the listed ${what} fields and retry.`,
  });
}
