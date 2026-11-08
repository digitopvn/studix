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
  /**
   * Read the workspace's own runtime logs (activity events of its jobs and projects) through
   * studix_query_logs / studix_tail_logs. Workspace owners hold it; admins and below only when it is
   * granted explicitly (an API key or OAuth scope created by an owner). Never carries infrastructure logs.
   */
  "logs:read",
  /**
   * Read platform-wide and infrastructure logs. Platform operators only, in their own dashboard session: no
   * API key, OAuth token or system actor can hold it, so no scope string can prove operator rights.
   */
  "logs:system:read",
  "asset:read",
  "asset:write",
  /**
   * Imported external Agent Skills (third-party instruction text kept in the workspace). Reading never
   * leaves Studix; writing contacts public GitHub and stores what it finds, so it is a separate grant.
   */
  "skill:read",
  "skill:write",
  /** Run ffmpeg/ffprobe with raw arguments in the worker sandbox (studix_media_exec); costs compute time. */
  "media:exec",
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
  "media:exec",
  "approval:request",
];

/**
 * Spelled out on purpose: a new permission must be granted to a role explicitly here, never picked up by
 * filtering the full list (that is how a platform-only or log-reading permission would leak to tenants).
 */
const TENANT_ADMIN: Permission[] = [
  ...EDIT,
  "approval:decide",
  "publish",
  "audit:read",
  "apikey:manage",
  "member:manage",
];
const TENANT_OWNER: Permission[] = [...TENANT_ADMIN, "logs:read"];

/** Role -> permission matrix. Reviewers may decide approvals but not edit; viewers only read. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  operator: new Set(PERMISSIONS),
  owner: new Set(TENANT_OWNER),
  admin: new Set(TENANT_ADMIN),
  editor: new Set(EDIT),
  reviewer: new Set([...READ, "approval:decide"]),
  viewer: new Set(READ),
};

/** System actors (workers, schedulers) can do anything except grant human approvals. */
const SYSTEM_PERMISSIONS: ReadonlySet<Permission> = new Set(
  PERMISSIONS.filter((p) => p !== "approval:decide" && p !== "logs:system:read"),
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
      // A scope string cannot prove the caller is the platform operator.
      return permission !== "logs:system:read" && actor.scopes.includes(permission);
    case "oauth":
      // Delegated agents never act as the platform operator, whatever the user's role.
      return (
        permission !== "job:recover" && permission !== "logs:system:read" && actor.scopes.includes(permission)
      );
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

/**
 * Platform-wide settings (object storage, media provider keys) belong to the platform's own staff acting in
 * a dashboard session. Workspace owners and admins do not hold them, and neither do API keys, OAuth-delegated
 * agents or system actors, so an agent can never change or reveal platform credentials.
 */
export function isPlatformOperator(actor: Actor): boolean {
  return actor.type === "user" && actor.role === "operator";
}

/** Throw FORBIDDEN unless the context is a platform operator's own dashboard session. */
export function assertPlatformOperator(ctx: TenantContext): void {
  if (!isPlatformOperator(ctx.actor)) {
    throw new StudixError("FORBIDDEN", "Only a platform operator can manage platform settings", {
      details: { actorType: ctx.actor.type },
      suggestedAction: "Ask the platform operator to change this setting.",
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
