import type { ApiKey, Member, Organization, Workspace } from "../entities/tenancy.ts";
import type { ActorRef, Permission, Role, TenantContext } from "../tenant.ts";

export interface WorkspaceRepository {
  /** The organization and workspace of the context; undefined if either was deleted. */
  get(ctx: TenantContext): Promise<{ organization: Organization; workspace: Workspace } | undefined>;
  listMembers(ctx: TenantContext): Promise<Member[]>;
  getMember(ctx: TenantContext, userId: string): Promise<Member | undefined>;
  /** Add the user or change their role. */
  upsertMember(ctx: TenantContext, input: { userId: string; role: Role }): Promise<Member>;
  removeMember(ctx: TenantContext, userId: string): Promise<boolean>;
}

export interface ProvisionWorkspaceInput {
  organization: { name: string; slug: string } | { id: string };
  workspace: { name: string; slug: string };
  /** Initial owner membership. */
  ownerUserId?: string;
}

export interface ResolvedApiKey {
  apiKey: ApiKey;
  organization: Organization;
  workspace: Workspace;
}

/**
 * The only unscoped persistence entry points: bootstrapping a tenant and resolving credentials into a
 * tenant. Everything after resolution must go through tenant-scoped repositories.
 */
export interface TenantDirectory {
  provisionWorkspace(
    input: ProvisionWorkspaceInput,
  ): Promise<{ organization: Organization; workspace: Workspace; owner?: Member }>;
  /** Active (not revoked, not expired) key by sha256 hash. */
  resolveApiKey(hash: string, now: Date): Promise<ResolvedApiKey | undefined>;
  /** Workspaces a user belongs to (dashboard session -> workspace picker). */
  listMemberships(
    userId: string,
  ): Promise<Array<{ member: Member; organization: Organization; workspace: Workspace }>>;
  /** A workspace and its organization by id (the operator's platform workspace at startup). */
  findWorkspace(
    workspaceId: string,
  ): Promise<{ organization: Organization; workspace: Workspace } | undefined>;
}

export interface NewApiKeyInput {
  name: string;
  hash: string;
  prefix: string;
  scopes: Permission[];
  createdBy: ActorRef;
  expiresAt?: Date;
}

export interface ApiKeyRepository {
  create(ctx: TenantContext, input: NewApiKeyInput): Promise<ApiKey>;
  get(ctx: TenantContext, id: string): Promise<ApiKey | undefined>;
  list(ctx: TenantContext): Promise<ApiKey[]>;
  /** Idempotent; throws NOT_FOUND for keys outside the tenant. */
  revoke(ctx: TenantContext, id: string): Promise<ApiKey>;
  touch(ctx: TenantContext, id: string, usedAt: Date): Promise<void>;
}
