import { JOB_SORT_FIELDS, JOB_STATUSES, type JobListQuery } from "@studix/core";
import { z } from "zod";
import { parseBody } from "./api-context.ts";

const Token = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
/** Comma-separated list, e.g. `status=queued,running`. */
const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .max(2000)
    .transform((v) => v.split(",").filter((s) => s.length > 0))
    .pipe(z.array(item).max(50));
const Search = z.string().trim().min(1).max(100);
const Instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const Count = z.coerce.number().int().min(0).max(1_000_000_000);
const Fraction = z.coerce.number().min(0).max(1);

/**
 * Allowlist for `GET /api/jobs`. Unknown params, sort fields and enum values fail with VALIDATION; the
 * sort field only ever selects a prebuilt expression, never a column name from the request.
 */
const JobListParams = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,400}$/)
      .optional(),
    sort: z.enum(JOB_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    projectId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
    status: csv(z.enum(JOB_STATUSES)).optional(),
    kind: csv(Token).optional(),
    stage: csv(Token).optional(),
    id: Search.optional(),
    project: Search.optional(),
    createdFrom: Instant.optional(),
    createdTo: Instant.optional(),
    updatedFrom: Instant.optional(),
    updatedTo: Instant.optional(),
    progressMin: Fraction.optional(),
    progressMax: Fraction.optional(),
    spentMin: Count.optional(),
    spentMax: Count.optional(),
  })
  .strict();

export function parseJobListQuery(query: unknown): JobListQuery {
  const { id, project, ...rest } = parseBody(JobListParams, query, "query");
  return { ...rest, idContains: id, projectContains: project };
}
