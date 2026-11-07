import { type Clock, newId, StudixError } from "@studix/shared";
import type { TenantOwned } from "../entities/common.ts";
import { type Page, pageLimit, toPage } from "../repositories/pagination.ts";
import { belongsTo, type TenantContext } from "../tenant.ts";

/**
 * Tenant-partitioned in-memory table used by the test fakes. Reads only ever see rows of the caller's
 * tenant, mirroring the WHERE organization_id/workspace_id filter of the Postgres repositories.
 */
export class InMemoryTenantTable<T extends TenantOwned> {
  private readonly rows = new Map<string, T>();

  /** @param hasUpdatedAt whether rows of this entity carry an `updatedAt` timestamp. */
  constructor(
    private readonly prefix: string,
    private readonly clock: Clock,
    private readonly hasUpdatedAt = true,
  ) {}

  insert(ctx: TenantContext, input: Omit<T, keyof TenantOwned | "updatedAt"> & { id?: string }): T {
    const now = this.clock.now();
    const row = {
      ...input,
      id: input.id ?? newId(this.prefix),
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      createdAt: now,
      ...(this.hasUpdatedAt ? { updatedAt: now } : {}),
    } as unknown as T;
    if (this.rows.has(row.id)) throw new StudixError("CONFLICT", `${this.prefix} ${row.id} already exists`);
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  get(ctx: TenantContext, id: string): T | undefined {
    const row = this.rows.get(id);
    return row && belongsTo(ctx, row) ? structuredClone(row) : undefined;
  }

  require(ctx: TenantContext, id: string): T {
    const row = this.get(ctx, id);
    if (!row) throw new StudixError("NOT_FOUND", `${this.prefix} ${id} not found`);
    return row;
  }

  update(ctx: TenantContext, id: string, patch: Partial<T>): T {
    const current = this.require(ctx, id);
    const next = { ...current, ...patch, ...(this.hasUpdatedAt ? { updatedAt: this.clock.now() } : {}) } as T;
    this.rows.set(id, structuredClone(next));
    return structuredClone(next);
  }

  delete(ctx: TenantContext, id: string): boolean {
    if (!this.get(ctx, id)) return false;
    return this.rows.delete(id);
  }

  /** All rows of the tenant matching `where`, newest id first. */
  filter(ctx: TenantContext, where: (row: T) => boolean = () => true): T[] {
    return [...this.rows.values()]
      .filter((row) => belongsTo(ctx, row) && where(row))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((row) => structuredClone(row));
  }

  /** Rows of every tenant matching `where`, newest id first; only for deliberately cross-tenant reads. */
  filterAnyTenant(where: (row: T) => boolean): T[] {
    return [...this.rows.values()]
      .filter(where)
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((row) => structuredClone(row));
  }

  page(ctx: TenantContext, query: { limit?: number; cursor?: string }, where?: (row: T) => boolean): Page<T> {
    const limit = pageLimit(query.limit);
    const rows = this.filter(ctx, where).filter((row) => query.cursor === undefined || row.id < query.cursor);
    return toPage(rows.slice(0, limit + 1), limit);
  }
}
