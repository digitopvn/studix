import type { ActorRef } from "../tenant.ts";

/** Fields every tenant-owned record carries. */
export interface TenantOwned {
  id: string;
  organizationId: string;
  workspaceId: string;
  createdAt: Date;
}

/** Fields assigned by repositories on create; callers never provide them. */
export type RepositoryManaged = "id" | "organizationId" | "workspaceId" | "createdAt" | "updatedAt";

/** Create-input for an entity: managed fields omitted, an explicit id may still be supplied. */
export type NewRecord<T> = Omit<T, RepositoryManaged> & { id?: string };

export type { ActorRef };
