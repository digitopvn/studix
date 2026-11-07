/**
 * Jobs page sort and filter state. The hash query uses the `GET /api/jobs` param names and units
 * (progress 0..1, spend in cents, ISO instants), so it is passed to the API as is and a shared link
 * reproduces the same list.
 */

export const JOB_STATUS_OPTIONS = [
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type JobSortField =
  | "createdAt"
  | "updatedAt"
  | "status"
  | "kind"
  | "stage"
  | "projectId"
  | "progress"
  | "spentCents";
export type SortOrder = "asc" | "desc";

/** Every param the page writes; anything else in the hash is dropped before it reaches the API. */
export const JOB_LIST_PARAMS = [
  "sort",
  "order",
  "status",
  "kind",
  "stage",
  "id",
  "project",
  "createdFrom",
  "createdTo",
  "updatedFrom",
  "updatedTo",
  "progressMin",
  "progressMax",
  "spentMin",
  "spentMax",
] as const;
export type JobListParam = (typeof JOB_LIST_PARAMS)[number];

export const DEFAULT_SORT: { sort: JobSortField; order: SortOrder } = { sort: "createdAt", order: "desc" };

const SORT_FIELDS: ReadonlySet<string> = new Set<JobSortField>([
  "createdAt",
  "updatedAt",
  "status",
  "kind",
  "stage",
  "projectId",
  "progress",
  "spentCents",
]);

/** Keep only the page's own params, in a stable order. */
export function jobListQuery(hash: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const name of JOB_LIST_PARAMS) {
    const value = hash.get(name);
    if (value !== null && value !== "") out.set(name, value);
  }
  return out;
}

export function currentSort(query: URLSearchParams): { sort: JobSortField; order: SortOrder } {
  const sort = query.get("sort");
  const order = query.get("order");
  return {
    sort: sort && SORT_FIELDS.has(sort) ? (sort as JobSortField) : DEFAULT_SORT.sort,
    order: order === "asc" || order === "desc" ? order : DEFAULT_SORT.order,
  };
}

/**
 * Clicking a header: the active column flips direction; a new column starts descending for dates and
 * numbers (newest/largest first) and ascending for text. The default sort is left out of the URL.
 */
export function toggleSort(query: URLSearchParams, field: JobSortField): URLSearchParams {
  const now = currentSort(query);
  const textual = field === "status" || field === "kind" || field === "stage" || field === "projectId";
  const order: SortOrder =
    now.sort === field ? (now.order === "asc" ? "desc" : "asc") : textual ? "asc" : "desc";
  const next = new URLSearchParams(query);
  if (field === DEFAULT_SORT.sort && order === DEFAULT_SORT.order) {
    next.delete("sort");
    next.delete("order");
  } else {
    next.set("sort", field);
    next.set("order", order);
  }
  return next;
}

/** Set or clear one filter param. */
export function withParam(
  query: URLSearchParams,
  name: JobListParam,
  value: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(query);
  if (value === undefined || value === "") next.delete(name);
  else next.set(name, value);
  return next;
}

export function listParam(query: URLSearchParams, name: JobListParam): string[] {
  return (query.get(name) ?? "").split(",").filter(Boolean);
}

export function withList(query: URLSearchParams, name: JobListParam, values: string[]): URLSearchParams {
  return withParam(query, name, values.join(","));
}

/** Drop every filter, keeping the sort. */
export function clearFilters(query: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  for (const name of ["sort", "order"] as const) {
    const value = query.get(name);
    if (value) next.set(name, value);
  }
  return next;
}

export function hasFilters(query: URLSearchParams): boolean {
  return JOB_LIST_PARAMS.some((name) => name !== "sort" && name !== "order" && query.has(name));
}

/** `<input type="date">` value (local day) to the ISO instant that starts (`from`) or ends (`to`) it. */
export function dayToInstant(day: string, edge: "from" | "to"): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = edge === "from" ? new Date(y, m - 1, d, 0, 0, 0, 0) : new Date(y, m - 1, d, 23, 59, 59, 999);
  return date.toISOString();
}

/** ISO instant back to the local day shown in a date input. */
export function instantToDay(instant: string | null): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Display units <-> API units: progress percent <-> 0..1, spend dollars <-> cents. */
export const UNIT_SCALE = { progress: 100, spent: 100 } as const;

export function toApiNumber(display: string, scale: number, integer: boolean): string | undefined {
  if (display.trim() === "") return undefined;
  const value = Number(display);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const api = integer ? Math.round(value * scale) : value / scale;
  return String(api);
}

export function toDisplayNumber(api: string | null, scale: number, integer: boolean): string {
  if (api === null || api === "") return "";
  const value = Number(api);
  if (!Number.isFinite(value)) return "";
  return String(integer ? value / scale : Math.round(value * scale * 100) / 100);
}
