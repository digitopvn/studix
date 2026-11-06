import { StudixError } from "@studix/shared";

/**
 * `operator` is the platform's own staff, never a tenant role: no service assigns it (owners manage members
 * but cannot grant a role above their own), so it is set directly in the database.
 */
export const ROLES = ["operator", "owner", "admin", "editor", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "workspace:read",
  "project:read",
  "project:write",
  "job:cancel",
  "job:retry",
  /**
   * Operator recovery of a job's media calls, e.g. attaching an upstream job found by hand. Platform
   * operators only: the upstream job is fetched with the platform's provider key, so a tenant could
   * otherwise collect another tenant's output.
   */
  "job:recover",
  "asset:read",
  "asset:write",
  /**
   * Imported external Agent Skills (third-party instruction text kept in the workspace). Reading never
   * leaves Studix; writing contacts public GitHub and stores what it finds, so it is a separate grant.
   */
  "skill:read",
  "skill:write",
  "approval:request",
  "approval:decide",
  "publish",
  "audit:read",
  "apikey:manage",
  "member:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ["workspace:read", "project:read", "asset:read", "skill:read"];
const EDIT: Permission[] = [
  ...READ,
  "project:write",
  "job:cancel",
  "job:retry",
  "asset:write",
  "skill:write",
  "approval:request",
];

const TENANT_ADMIN: Permission[] = PERMISSIONS.filter((p) => p !== "job:recover");

/** Role -> permission matrix. Reviewers may decide approvals but not edit; viewers only read. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  operator: new Set(PERMISSIONS),
  owner: new Set(TENANT_ADMIN),
  admin: new Set(TENANT_ADMIN),
  editor: new Set(EDIT),
  reviewer: new Set([...READ, "approval:decide"]),
  viewer: new Set(READ),
};

/** System actors (workers, schedulers) can do anything except grant human approvals. */
const SYSTEM_PERMISSIONS: ReadonlySet<Permission> = new Set(
  PERMISSIONS.filter((p) => p !== "approval:decide"),
);

export type Actor =
  | { type: "user"; id: string; role: Role }
  | { type: "apiKey"; id: string; scopes: readonly Permission[] }
  /**
   * An AI client acting for a user through an OAuth access token. `id` is the user's id; `scopes` are the
   * permissions that survive both the granted OAuth scopes and the user's current role. Never a "user":
   * human-only decisions (approvals) stay out of reach of delegated agents.
   */
  | { type: "oauth"; id: string; clientId: string; scopes: readonly Permission[] }
  | { type: "system"; id: string };

/** Who did something, as stored on records (no role/scope snapshot). */
export interface ActorRef {
  type: Actor["type"];
  id: string;
}

/** Every repository and service call is scoped by this. Built by the auth layer, never by clients. */
export interface TenantContext {
  organizationId: string;
  workspaceId: string;
  actor: Actor;
}

export function actorRef(actor: Actor): ActorRef {
  return { type: actor.type, id: actor.id };
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export function can(actor: Actor, permission: Permission): boolean {
  switch (actor.type) {
    case "user":
      return ROLE_PERMISSIONS[actor.role]?.has(permission) ?? false;
    case "apiKey":
      return actor.scopes.includes(permission);
    case "oauth":
      // Delegated agents never act as the platform operator, whatever the user's role.
      return permission !== "job:recover" && actor.scopes.includes(permission);
    case "system":
      return SYSTEM_PERMISSIONS.has(permission);
    default:
      return false;
  }
}

/** Throw FORBIDDEN unless the context's actor holds the permission. */
export function assertPermission(ctx: TenantContext, permission: Permission): void {
  if (!can(ctx.actor, permission)) {
    throw new StudixError("FORBIDDEN", `Missing permission ${permission}`, {
      details: { permission, actorType: ctx.actor.type },
      suggestedAction:
        ctx.actor.type === "apiKey"
          ? `Use an API key with the "${permission}" scope.`
          : ctx.actor.type === "oauth"
            ? "Reconnect the app with a broader scope, or ask a workspace admin for a role that grants this action."
            : "Ask a workspace admin for a role that grants this action.",
    });
  }
}

/** Validate a TenantContext at a system boundary (e.g. built from a decoded token). */
export function assertTenantContext(ctx: TenantContext | undefined): asserts ctx is TenantContext {
  if (!ctx?.organizationId || !ctx.workspaceId || !ctx.actor?.id) {
    throw new StudixError("UNAUTHENTICATED", "Missing tenant context", {
      suggestedAction: "Authenticate with a workspace API key or a dashboard session.",
    });
  }
}

/** True when a tenant-owned record belongs to the context's workspace. */
export function belongsTo(
  ctx: TenantContext,
  record: { organizationId: string; workspaceId: string },
): boolean {
  return record.organizationId === ctx.organizationId && record.workspaceId === ctx.workspaceId;
}
