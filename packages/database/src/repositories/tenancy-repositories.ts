import type {
  ApiKey,
  ApiKeyRepository,
  Member,
  Organization,
  TenantContext,
  TenantDirectory,
  Workspace,
  WorkspaceRepository,
} from "@studix/core";
import { type Clock, newId, StudixError } from "@studix/shared";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { StudixDb } from "../client.ts";
import { providerConnections } from "../schema/provider-connections.ts";
import { apiKeys, members, organizations, workspaces } from "../schema/tenancy.ts";
import { actorFrom, first, isUniqueViolation, opt, scoped, tenantValues } from "./helpers.ts";

const toOrganization = (row: typeof organizations.$inferSelect): Organization => ({ ...row });
const toWorkspace = (row: typeof workspaces.$inferSelect): Workspace => ({ ...row });
const toMember = (row: typeof members.$inferSelect): Member => ({ ...row });

function toApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    name: row.name,
    hash: row.hash,
    prefix: row.prefix,
    scopes: row.scopes,
    createdBy: actorFrom(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    lastUsedAt: opt(row.lastUsedAt),
    expiresAt: opt(row.expiresAt),
    revokedAt: opt(row.revokedAt),
  };
}

/** Unscoped bootstrap/credential-resolution entry points (see TenantDirectory). */
export function createTenantDirectory(db: StudixDb, clock: Clock): TenantDirectory {
  return {
    async provisionWorkspace(input) {
      try {
        return await db.transaction(async (tx) => {
          const now = clock.now();
          let organization: Organization;
          if ("id" in input.organization) {
            const rows = await tx
              .select()
              .from(organizations)
              .where(eq(organizations.id, input.organization.id));
            organization = toOrganization(first(rows, `organization ${input.organization.id}`));
          } else {
            const rows = await tx
              .insert(organizations)
              .values({ id: newId("org"), ...input.organization, createdAt: now, updatedAt: now })
              .returning();
            organization = toOrganization(first(rows, "organization"));
          }
          const wsRows = await tx
            .insert(workspaces)
            .values({
              id: newId("ws"),
              organizationId: organization.id,
              ...input.workspace,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          const workspace = toWorkspace(first(wsRows, "workspace"));
          let owner: Member | undefined;
          if (input.ownerUserId) {
            const memberRows = await tx
              .insert(members)
              .values({
                id: newId("mem"),
                organizationId: organization.id,
                workspaceId: workspace.id,
                userId: input.ownerUserId,
                role: "owner",
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            owner = toMember(first(memberRows, "member"));
          }
          return { organization, workspace, owner };
        });
      } catch (err) {
        if (isUniqueViolation(err))
          throw new StudixError("CONFLICT", "organization or workspace slug already taken");
        throw err;
      }
    },

    async resolveApiKey(hash, now) {
      const rows = await db
        .select({ key: apiKeys, organization: organizations, workspace: workspaces })
        .from(apiKeys)
        .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
        .innerJoin(organizations, eq(organizations.id, apiKeys.organizationId))
        .where(
          and(
            eq(apiKeys.hash, hash),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
            eq(workspaces.organizationId, apiKeys.organizationId),
          ),
        );
      const row = rows[0];
      if (!row) return undefined;
      return {
        apiKey: toApiKey(row.key),
        organization: toOrganization(row.organization),
        workspace: toWorkspace(row.workspace),
      };
    },

    async listMemberships(userId) {
      const rows = await db
        .select({ member: members, organization: organizations, workspace: workspaces })
        .from(members)
        .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
        .innerJoin(organizations, eq(organizations.id, members.organizationId))
        .where(eq(members.userId, userId))
        .orderBy(asc(workspaces.id));
      return rows.map((r) => ({
        member: toMember(r.member),
        organization: toOrganization(r.organization),
        workspace: toWorkspace(r.workspace),
      }));
    },

    async findWorkspace(workspaceId) {
      const rows = await db
        .select({ organization: organizations, workspace: workspaces })
        .from(workspaces)
        .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      const row = rows[0];
      return row
        ? { organization: toOrganization(row.organization), workspace: toWorkspace(row.workspace) }
        : undefined;
    },
  };
}

export function createWorkspaceRepository(db: StudixDb, clock: Clock): WorkspaceRepository {
  const findMember = async (ctx: TenantContext, userId: string) =>
    (
      await db
        .select()
        .from(members)
        .where(scoped(members, ctx, eq(members.userId, userId)))
    )[0];
  return {
    async get(ctx) {
      const rows = await db
        .select({ organization: organizations, workspace: workspaces })
        .from(workspaces)
        .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
        .where(and(eq(workspaces.id, ctx.workspaceId), eq(workspaces.organizationId, ctx.organizationId)));
      const row = rows[0];
      return row
        ? { organization: toOrganization(row.organization), workspace: toWorkspace(row.workspace) }
        : undefined;
    },
    async listMembers(ctx) {
      const rows = await db.select().from(members).where(scoped(members, ctx)).orderBy(asc(members.id));
      return rows.map(toMember);
    },
    async getMember(ctx, userId) {
      const row = await findMember(ctx, userId);
      return row ? toMember(row) : undefined;
    },
    async upsertMember(ctx, input) {
      const now = clock.now();
      const rows = await db
        .insert(members)
        .values({
          id: newId("mem"),
          ...tenantValues(ctx),
          userId: input.userId,
          role: input.role,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [members.workspaceId, members.userId],
          set: { role: input.role, updatedAt: now },
          setWhere: scoped(members, ctx),
        })
        .returning();
      return toMember(first(rows, "member"));
    },
    async removeMember(ctx, userId) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .delete(members)
          .where(scoped(members, ctx, eq(members.userId, userId)))
          .returning({ id: members.id });
        if (rows.length === 0) return false;
        // A former member's personal provider keys must stop working and must not linger encrypted.
        const now = clock.now();
        await tx
          .update(providerConnections)
          .set({ status: "revoked", secretCiphertext: null, revokedAt: now, updatedAt: now })
          .where(
            scoped(
              providerConnections,
              ctx,
              and(eq(providerConnections.ownerUserId, userId), isNull(providerConnections.revokedAt)),
            ),
          );
        return true;
      });
    },
  };
}

export function createApiKeyRepository(db: StudixDb, clock: Clock): ApiKeyRepository {
  return {
    async create(ctx, input) {
      try {
        const rows = await db
          .insert(apiKeys)
          .values({
            id: newId("key"),
            ...tenantValues(ctx),
            name: input.name,
            hash: input.hash,
            prefix: input.prefix,
            scopes: input.scopes,
            createdByType: input.createdBy.type,
            createdById: input.createdBy.id,
            createdAt: clock.now(),
            expiresAt: input.expiresAt ?? null,
          })
          .returning();
        return toApiKey(first(rows, "api key"));
      } catch (err) {
        if (isUniqueViolation(err)) throw new StudixError("CONFLICT", "api key hash already exists");
        throw err;
      }
    },
    async get(ctx, id) {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(scoped(apiKeys, ctx, eq(apiKeys.id, id)));
      return rows[0] ? toApiKey(rows[0]) : undefined;
    },
    async list(ctx) {
      const rows = await db.select().from(apiKeys).where(scoped(apiKeys, ctx)).orderBy(desc(apiKeys.id));
      return rows.map(toApiKey);
    },
    async revoke(ctx, id) {
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: clock.now() })
        .where(scoped(apiKeys, ctx, eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .returning();
      if (rows[0]) return toApiKey(rows[0]);
      const existing = await db
        .select()
        .from(apiKeys)
        .where(scoped(apiKeys, ctx, eq(apiKeys.id, id)));
      return toApiKey(first(existing, `api key ${id}`));
    },
    async touch(ctx, id, usedAt) {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: usedAt })
        .where(scoped(apiKeys, ctx, eq(apiKeys.id, id)));
    },
  };
}
