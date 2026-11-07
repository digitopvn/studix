import { StudixError } from "@studix/shared";
import type { Job, JobStatus } from "../entities/job.ts";
import { type JobAgentRuntime, jobAgent } from "../entities/job-agent.ts";
import type { Page, PageRequest } from "./pagination.ts";

/** Columns a job list can be sorted by. Anything else is rejected before it reaches a query. */
export const JOB_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "status",
  "kind",
  "stage",
  "projectId",
  "progress",
  "spentCents",
  "agent",
  "model",
] as const;
export type JobSortField = (typeof JOB_SORT_FIELDS)[number];
export type SortOrder = "asc" | "desc";

/**
 * Filtered, sorted job page. The cursor is opaque: it encodes the sort value and id of the last item, so
 * pages stay stable under any sort (keyset on (sort column, id)). A cursor is only valid for the sort it
 * was issued under.
 */
export interface JobListQuery extends PageRequest {
  sort?: JobSortField;
  order?: SortOrder;
  /** Exact project id (used by project pages). */
  projectId?: string;
  status?: JobStatus[];
  kind?: string[];
  stage?: string[];
  /** Agent runtimes (see `jobAgent`). */
  agent?: JobAgentRuntime[];
  /** Case-insensitive substring of the agent model id. */
  modelContains?: string;
  /** Case-insensitive substring of the job id. */
  idContains?: string;
  /** Case-insensitive substring of the project id. */
  projectContains?: string;
  createdFrom?: Date;
  createdTo?: Date;
  updatedFrom?: Date;
  updatedTo?: Date;
  /** Progress bounds, 0..1, inclusive. */
  progressMin?: number;
  progressMax?: number;
  /** Spend bounds in cents, inclusive. */
  spentMin?: number;
  spentMax?: number;
}

export type JobSortValue = string | number;

const NUMERIC_FIELDS: ReadonlySet<JobSortField> = new Set(["progress", "spentCents"]);
const DATE_FIELDS: ReadonlySet<JobSortField> = new Set(["createdAt", "updatedAt"]);

/**
 * The value a job sorts by. Missing stage/project sort as "" (the database uses COALESCE), and dates
 * as epoch milliseconds (the database truncates to milliseconds) so a cursor round-trips exactly.
 */
export function jobSortValue(job: Job, field: JobSortField): JobSortValue {
  switch (field) {
    case "createdAt":
      return job.createdAt.getTime();
    case "updatedAt":
      return job.updatedAt.getTime();
    case "stage":
      return job.stage ?? "";
    case "projectId":
      return job.projectId ?? "";
    case "progress":
      return job.progress;
    case "spentCents":
      return job.spentCents;
    case "agent":
      return jobAgent(job).runtime;
    case "model":
      return jobAgent(job).model ?? "";
    default:
      return job[field];
  }
}

export function encodeJobCursor(value: JobSortValue, id: string): string {
  return Buffer.from(JSON.stringify([value, id]), "utf8").toString("base64url");
}

/** Decode a cursor for `field`, failing with VALIDATION when it is malformed or from another sort. */
export function decodeJobCursor(cursor: string, field: JobSortField): { value: JobSortValue; id: string } {
  const invalid = () =>
    new StudixError("VALIDATION", "Invalid cursor", {
      suggestedAction: "Drop the cursor and list from the first page.",
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
  const [value, id] = parsed as [unknown, unknown];
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw invalid();
  const numeric = NUMERIC_FIELDS.has(field) || DATE_FIELDS.has(field);
  if (numeric ? typeof value !== "number" || !Number.isFinite(value) : typeof value !== "string") {
    throw invalid();
  }
  return { value: value as JobSortValue, id };
}

/** Build a page from `limit + 1` rows already ordered by (sort, id). */
export function toJobPage(rows: Job[], limit: number, field: JobSortField): Page<Job> {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  return { items, nextCursor: encodeJobCursor(jobSortValue(last, field), last.id) };
}

function compareValues(a: JobSortValue, b: JobSortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Comparator for (sort, id) in the requested order, matching the database ordering. */
export function compareJobs(field: JobSortField, order: SortOrder): (a: Job, b: Job) => number {
  const sign = order === "asc" ? 1 : -1;
  return (a, b) =>
    sign * (compareValues(jobSortValue(a, field), jobSortValue(b, field)) || compareValues(a.id, b.id));
}

/** True when `job` comes strictly after the cursor row under (sort, id) in `order`. */
export function isAfterJobCursor(
  job: Job,
  field: JobSortField,
  order: SortOrder,
  cursor: { value: JobSortValue; id: string },
): boolean {
  const cmp = compareValues(jobSortValue(job, field), cursor.value) || compareValues(job.id, cursor.id);
  return order === "asc" ? cmp > 0 : cmp < 0;
}

/** In-memory form of every filter and the cursor; the reference behavior for the SQL query. */
export function jobMatches(job: Job, query: JobListQuery): boolean {
  const has = (needle: string | undefined, hay: string | undefined) =>
    needle === undefined || (hay ?? "").toLowerCase().includes(needle.toLowerCase());
  const within = (value: number, min?: number, max?: number) =>
    (min === undefined || value >= min) && (max === undefined || value <= max);
  const time = (d: Date, from?: Date, to?: Date) => within(d.getTime(), from?.getTime(), to?.getTime());
  return (
    (query.projectId === undefined || job.projectId === query.projectId) &&
    (!query.status?.length || query.status.includes(job.status)) &&
    (!query.kind?.length || query.kind.includes(job.kind)) &&
    (!query.stage?.length || query.stage.includes(job.stage ?? "")) &&
    (!query.agent?.length || query.agent.includes(jobAgent(job).runtime)) &&
    has(query.modelContains, jobAgent(job).model) &&
    has(query.idContains, job.id) &&
    has(query.projectContains, job.projectId) &&
    time(job.createdAt, query.createdFrom, query.createdTo) &&
    time(job.updatedAt, query.updatedFrom, query.updatedTo) &&
    within(job.progress, query.progressMin, query.progressMax) &&
    within(job.spentCents, query.spentMin, query.spentMax)
  );
}
