import { type Clock, newId, StudixError } from "@studix/shared";
import type { ApiKey, Member, Organization, Workspace } from "../entities/tenancy.ts";
import type {
  ApiKeyRepository,
  TenantDirectory,
  WorkspaceRepository,
} from "../repositories/tenancy-repositories.ts";
import type { TenantContext } from "../tenant.ts";
import { InMemoryTenantTable } from "./in-memory-table.ts";

/** In-memory organizations, workspaces, members and API keys sharing one directory. */
export function createInMemoryTenancy(clock: Clock): {
  directory: TenantDirectory;
  workspaces: WorkspaceRepository;
  apiKeys: ApiKeyRepository;
} {
  const orgs = new Map<string, Organization>();
  const spaces = new Map<string, Workspace>();
  const members = new InMemoryTenantTable<Member>("mem", clock);
  const keys = new InMemoryTenantTable<ApiKey>("key", clock, false);
  /** Unscoped view of keys for hash resolution (the directory is the only unscoped reader). */
  const keysByHash = new Map<string, { id: string; organizationId: string; workspaceId: string }>();

  const tenantOf = (workspace: Workspace): TenantContext => ({
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    actor: { type: "system", id: "tenant-directory" },
  });

  const directory: TenantDirectory = {
    async provisionWorkspace(input) {
      const now = clock.now();
      let organization: Organization | undefined;
      if ("id" in input.organization) {
        organization = orgs.get(input.organization.id);
        if (!organization) throw new StudixError("NOT_FOUND", "organization not found");
      } else {
        const { slug, name } = input.organization;
        if ([...orgs.values()].some((o) => o.slug === slug)) throw new StudixError("CONFLICT", "slug taken");
        organization = { id: newId("org"), name, slug, createdAt: now, updatedAt: now };
        orgs.set(organization.id, organization);
      }
      const orgId = organization.id;
      if ([...spaces.values()].some((w) => w.organizationId === orgId && w.slug === input.workspace.slug)) {
        throw new StudixError("CONFLICT", "workspace slug taken");
      }
      const workspace: Workspace = {
        id: newId("ws"),
        organizationId: orgId,
        ...input.workspace,
        createdAt: now,
        updatedAt: now,
      };
      spaces.set(workspace.id, workspace);
      const owner = input.ownerUserId
        ? members.insert(tenantOf(workspace), { userId: input.ownerUserId, role: "owner" })
        : undefined;
      return { organization, workspace, owner };
    },
    async resolveApiKey(hash, now) {
      const ref = keysByHash.get(hash);
      const workspace = ref ? spaces.get(ref.workspaceId) : undefined;
      const organization = ref ? orgs.get(ref.organizationId) : undefined;
      if (!ref || !workspace || !organization) return undefined;
      const apiKey = keys.get(tenantOf(workspace), ref.id);
      if (!apiKey || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= now)) return undefined;
      return { apiKey, organization, workspace };
    },
    async listMemberships(userId) {
      const out: Array<{ member: Member; organization: Organization; workspace: Workspace }> = [];
      for (const workspace of spaces.values()) {
        const member = members.filter(tenantOf(workspace), (m) => m.userId === userId)[0];
        const organization = orgs.get(workspace.organizationId);
        if (member && organization) out.push({ member, organization, workspace });
      }
      return out;
    },
    async findWorkspace(workspaceId) {
      const workspace = spaces.get(workspaceId);
      const organization = workspace ? orgs.get(workspace.organizationId) : undefined;
      return workspace && organization ? { organization, workspace } : undefined;
    },
  };

  const workspaces: WorkspaceRepository = {
    async get(ctx) {
      const workspace = spaces.get(ctx.workspaceId);
      const organization = orgs.get(ctx.organizationId);
      if (!workspace || !organization || workspace.organizationId !== organization.id) return undefined;
      return { organization, workspace };
    },
    async listMembers(ctx) {
      return members.filter(ctx);
    },
    async getMember(ctx, userId) {
      return members.filter(ctx, (m) => m.userId === userId)[0];
    },
    async upsertMember(ctx, input) {
      const existing = members.filter(ctx, (m) => m.userId === input.userId)[0];
      return existing ? members.update(ctx, existing.id, { role: input.role }) : members.insert(ctx, input);
    },
    async removeMember(ctx, userId) {
      const existing = members.filter(ctx, (m) => m.userId === userId)[0];
      return existing ? members.delete(ctx, existing.id) : false;
    },
  };

  const apiKeys: ApiKeyRepository = {
    async create(ctx, input) {
      if (keysByHash.has(input.hash)) throw new StudixError("CONFLICT", "api key hash already exists");
      const key = keys.insert(ctx, input);
      keysByHash.set(key.hash, {
        id: key.id,
        organizationId: key.organizationId,
        workspaceId: key.workspaceId,
      });
      return key;
    },
    async get(ctx, id) {
      return keys.get(ctx, id);
    },
    async list(ctx) {
      return keys.filter(ctx);
    },
    async revoke(ctx, id) {
      const key = keys.require(ctx, id);
      return key.revokedAt ? key : keys.update(ctx, id, { revokedAt: clock.now() });
    },
    async touch(ctx, id, usedAt) {
      keys.update(ctx, id, { lastUsedAt: usedAt });
    },
  };

  return { directory, workspaces, apiKeys };
}
