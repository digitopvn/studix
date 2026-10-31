import { StudixError } from "@studix/shared";
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
  | "unsupported_version";

/** One problem, addressed by RFC 6901 JSON pointer into the validated document. */
export interface ValidationIssue {
  path: string;
  code: ValidationIssueCode;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export function toPointer(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return `/${path.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

export function fromZodIssues(issues: ReadonlyArray<z.core.$ZodIssue>): ValidationIssue[] {
  return issues.map((issue) => ({ path: toPointer(issue.path), code: "schema", message: issue.message }));
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
