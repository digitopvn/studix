import type { TenantContext } from "@studix/core";
import { InMemoryTenantTable } from "@studix/core/testing";
import { type Clock, StudixError } from "@studix/shared";
import type { Connector, ConnectorRepository } from "../registry/connector-types.ts";

/** Tenant-partitioned in-memory ConnectorRepository mirroring the Postgres implementation. */
export function createInMemoryConnectorRepository(clock: Clock): ConnectorRepository {
  const table = new InMemoryTenantTable<Connector>("conn", clock);
  return {
    async create(ctx: TenantContext, input) {
      if (table.filter(ctx, (row) => row.name === input.name).length > 0) {
        throw new StudixError("CONFLICT", `Connector ${input.name} already exists`);
      }
      return table.insert(ctx, { ...input, tools: [], version: 1 });
    },
    async get(ctx, id) {
      return table.get(ctx, id);
    },
    async getByName(ctx, name) {
      return table.filter(ctx, (row) => row.name === name)[0];
    },
    async list(ctx, query = {}) {
      return table
        .filter(ctx, (row) => query.status === undefined || row.status === query.status)
        .slice(0, 200);
    },
    async update(ctx, id, patch) {
      const current = table.require(ctx, id);
      const { secretRef, ...rest } = patch;
      const next: Partial<Connector> = { ...rest, version: current.version + 1 };
      if (secretRef === null) next.secretRef = undefined;
      else if (secretRef !== undefined) next.secretRef = secretRef;
      return table.update(ctx, id, next);
    },
  };
}
