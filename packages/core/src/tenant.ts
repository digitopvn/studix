import { StudixError } from "@studix/shared";

export const ROLES = ["owner", "admin", "editor", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "workspace:read",
  "project:read",
  "project:write",
  "job:cancel",
  "job:retry",
  /** Platform operator recovery of a job's media calls, e.g. attaching an upstream job found by hand. */
  "job:recover",
  "asset:read",
  "asset:write",
  "approval:request",
  "approval:decide",
  "publish",
  "audit:read",
  "apikey:manage",
  "member:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Held only by system actors (the operator CLI), never by a workspace role or API key: attaching an upstream
 * job trusts its id without checking it against the provider, and every workspace shares the platform's
 * provider account, so a tenant could otherwise collect another workspace's media.
 */
const OPERATOR_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(["job:recover"]);
const WORKSPACE_PERMISSIONS = PERMISSIONS.filter((p) => !OPERATOR_PERMISSIONS.has(p));

const READ: Permission[] = ["workspace:read", "project:read", "asset:read"];
const EDIT: Permission[] = [
  ...READ,
  "project:write",
  "job:cancel",
  "job:retry",
  "asset:write",
  "approval:request",
];

/** Role -> permission matrix. Reviewers may decide approvals but not edit; viewers only read. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  owner: new Set(WORKSPACE_PERMISSIONS),
  admin: new Set(WORKSPACE_PERMISSIONS),
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
      // A key issued before a permission became operator-only may still list it.
      return !OPERATOR_PERMISSIONS.has(permission) && actor.scopes.includes(permission);
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
      suggestedAction: OPERATOR_PERMISSIONS.has(permission)
        ? "Only the Studix platform operator can do this; contact them."
        : ctx.actor.type === "apiKey"
          ? `Use an API key with the "${permission}" scope.`
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
