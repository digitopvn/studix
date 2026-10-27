import type { ActorRef, TenantContext } from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { desc, eq, sql } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import {
  type ConnectorStatusValue,
  mcpConnectors,
  type StoredConnectorTestResult,
  type StoredConnectorTool,
  type StoredToolPolicy,
} from "../schema/connectors.ts";
import { actorFrom, first, isUniqueViolation, scoped, tenantValues } from "./helpers.ts";

/*
 * Postgres implementation of `ConnectorRepository` from @studix/mcp-gateway. The record shapes below are
 * structurally identical to the gateway's domain types (the gateway's integration test assigns this
 * repository to its interface, so drift fails typecheck).
 */

export interface ConnectorTestResultRecord extends Omit<StoredConnectorTestResult, "at"> {
  at: Date;
}

export interface ConnectorRecord {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  url: string;
  transport: "streamable-http";
  status: ConnectorStatusValue;
  secretRef?: string;
  toolPolicy: StoredToolPolicy;
  tools: StoredConnectorTool[];
  version: number;
  lastTest?: ConnectorTestResultRecord;
  createdBy: ActorRef;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewConnectorRecord {
  id?: string;
  name: string;
  url: string;
  transport: "streamable-http";
  status: ConnectorStatusValue;
  secretRef?: string;
  toolPolicy: StoredToolPolicy;
  createdBy: ActorRef;
}

export interface ConnectorRecordPatch {
  url?: string;
  status?: ConnectorStatusValue;
  secretRef?: string | null;
  toolPolicy?: StoredToolPolicy;
  tools?: StoredConnectorTool[];
  lastTest?: ConnectorTestResultRecord;
}

export interface PostgresConnectorRepository {
  create(ctx: TenantContext, input: NewConnectorRecord): Promise<ConnectorRecord>;
  get(ctx: TenantContext, id: string): Promise<ConnectorRecord | undefined>;
  getByName(ctx: TenantContext, name: string): Promise<ConnectorRecord | undefined>;
  list(ctx: TenantContext, query?: { status?: ConnectorStatusValue }): Promise<ConnectorRecord[]>;
  update(ctx: TenantContext, id: string, patch: ConnectorRecordPatch): Promise<ConnectorRecord>;
}

/** Upper bound on connectors returned by `list` (the gateway caps registrations well below this). */
const MAX_LIST = 200;

function toConnector(row: typeof mcpConnectors.$inferSelect): ConnectorRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    name: row.name,
    url: row.url,
    transport: row.transport,
    status: row.status,
    ...(row.secretRef !== null ? { secretRef: row.secretRef } : {}),
    toolPolicy: row.toolPolicy,
    tools: row.tools,
    version: row.version,
    ...(row.lastTest ? { lastTest: { ...row.lastTest, at: new Date(row.lastTest.at) } } : {}),
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createConnectorRepository(db: StudixDb, clock: Clock): PostgresConnectorRepository {
  return {
    async create(ctx, input) {
      const now = clock.now();
      try {
        const rows = await db
          .insert(mcpConnectors)
          .values({
            id: input.id ?? newId("conn"),
            ...tenantValues(ctx),
            name: input.name,
            url: input.url,
            transport: input.transport,
            status: input.status,
            secretRef: input.secretRef ?? null,
            toolPolicy: input.toolPolicy,
            tools: [],
            version: 1,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return toConnector(first(rows, "connector"));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StudixError("CONFLICT", `Connector ${input.name} already exists`);
        }
        throw error;
      }
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(mcpConnectors)
        .where(scoped(mcpConnectors, ctx, eq(mcpConnectors.id, id)));
      return rows[0] ? toConnector(rows[0]) : undefined;
    },
    async getByName(ctx, name) {
      const rows = await db
        .select()
        .from(mcpConnectors)
        .where(scoped(mcpConnectors, ctx, eq(mcpConnectors.name, name)));
      return rows[0] ? toConnector(rows[0]) : undefined;
    },
    async list(ctx, query = {}) {
      const rows = await db
        .select()
        .from(mcpConnectors)
        .where(scoped(mcpConnectors, ctx, query.status ? eq(mcpConnectors.status, query.status) : undefined))
        .orderBy(desc(mcpConnectors.id))
        .limit(MAX_LIST);
      return rows.map(toConnector);
    },
    async update(ctx, id, patch) {
      const rows = await db
        .update(mcpConnectors)
        .set({
          ...(patch.url !== undefined ? { url: patch.url } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.secretRef !== undefined ? { secretRef: patch.secretRef } : {}),
          ...(patch.toolPolicy !== undefined ? { toolPolicy: patch.toolPolicy } : {}),
          ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
          ...(patch.lastTest !== undefined
            ? { lastTest: { ...patch.lastTest, at: patch.lastTest.at.toISOString() } }
            : {}),
          version: sql`${mcpConnectors.version} + 1`,
          updatedAt: clock.now(),
        })
        .where(scoped(mcpConnectors, ctx, eq(mcpConnectors.id, id)))
        .returning();
      return toConnector(first(rows, `connector ${id}`));
    },
  };
}
