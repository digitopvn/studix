import type { Permission, Role } from "../tenant.ts";
import type { ActorRef, TenantOwned } from "./common.ts";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface Member extends TenantOwned {
  userId: string;
  role: Role;
  updatedAt: Date;
}

/** Workspace API key record. Only the sha256 hash is stored; `prefix` is a non-secret display hint. */
export interface ApiKey extends TenantOwned {
  name: string;
  hash: string;
  prefix: string;
  scopes: Permission[];
  createdBy: ActorRef;
  lastUsedAt?: Date;
  expiresAt?: Date;
  revokedAt?: Date;
}
