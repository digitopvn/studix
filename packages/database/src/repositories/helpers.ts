import type { ActorRef, TenantContext } from "@studix/core";
import { pageLimit, toPage } from "@studix/core";
import { StudixError } from "@studix/shared";
import { and, eq, lt, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { ActorType } from "../schema/columns.ts";

interface TenantTable {
  organizationId: PgColumn;
  workspaceId: PgColumn;
}

/** WHERE clause every tenant-owned query starts from. */
export function tenantScope(table: TenantTable, ctx: TenantContext): SQL {
  return and(eq(table.organizationId, ctx.organizationId), eq(table.workspaceId, ctx.workspaceId))!;
}

/** Tenant column values for inserts, taken from the context only. */
export function tenantValues(ctx: TenantContext): { organizationId: string; workspaceId: string } {
  return { organizationId: ctx.organizationId, workspaceId: ctx.workspaceId };
}

/** Combine the tenant scope with optional extra predicates. */
export function scoped(table: TenantTable, ctx: TenantContext, ...conditions: Array<SQL | undefined>): SQL {
  return and(tenantScope(table, ctx), ...conditions)!;
}

/** Keyset condition for newest-first pages. */
export function beforeCursor(idColumn: PgColumn, cursor: string | undefined): SQL | undefined {
  return cursor === undefined ? undefined : lt(idColumn, cursor);
}

export { pageLimit, toPage };

/** Convert SQL NULLs to undefined so rows match the optional fields of core entities. */
export function opt<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

export function actorFrom(type: ActorType, id: string): ActorRef {
  return { type, id };
}

export function first<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new StudixError("NOT_FOUND", `${what} not found`);
  return row;
}

/** Postgres unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code ??
    (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505";
}
