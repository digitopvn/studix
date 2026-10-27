import { StudixError } from "@studix/shared";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Keyset pagination. Ids are time-sortable, so lists are ordered newest first by id and `cursor` is the
 * id of the last item of the previous page.
 */
export interface PageRequest {
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Clamp a requested page size into [1, MAX_PAGE_SIZE]. */
export function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new StudixError("VALIDATION", "limit must be a positive integer", { details: { limit } });
  }
  return Math.min(limit, MAX_PAGE_SIZE);
}

/** Build a page from `limit + 1` fetched rows. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  return { items, nextCursor: items[items.length - 1]!.id };
}
