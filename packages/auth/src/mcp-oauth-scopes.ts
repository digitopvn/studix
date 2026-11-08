import { isPermission, type Permission } from "@studix/core";

/**
 * OAuth scopes an AI client can be granted on the MCP endpoint, and the Studix permissions each stands for.
 * A token never exceeds the permissions of its user's role in the chosen workspace; the scopes only narrow
 * it. Approvals, publishing, API-key and member administration are not reachable through OAuth.
 */
export const MCP_OAUTH_SCOPES = {
  "studix:read": ["workspace:read", "project:read", "asset:read", "skill:read"],
  "studix:write": [
    "project:write",
    "job:cancel",
    "job:retry",
    "asset:write",
    "skill:write",
    "media:exec",
    "approval:request",
  ],
  /** Runtime logs of the workspace; effective only for roles that hold `logs:read` (owners). */
  "studix:logs": ["logs:read"],
} as const satisfies Record<string, readonly Permission[]>;

export type McpOAuthScope = keyof typeof MCP_OAUTH_SCOPES;

/** Standard scope that lets a client keep a refresh token; carries no permission. */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

export const MCP_SUPPORTED_SCOPES: readonly string[] = [
  ...Object.keys(MCP_OAUTH_SCOPES),
  OFFLINE_ACCESS_SCOPE,
];

/** Scope a client gets when it asks for none. */
export const MCP_DEFAULT_SCOPES: readonly string[] = ["studix:read"];

/** Permissions the granted scopes stand for; unknown scopes grant nothing. */
export function permissionsForScopes(scopes: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const scope of scopes) {
    const granted = (MCP_OAUTH_SCOPES as Record<string, readonly string[]>)[scope];
    for (const permission of granted ?? []) if (isPermission(permission)) out.add(permission);
  }
  return [...out];
}

/** Split an OAuth `scope` string/array claim into scope names. */
export function parseScopeClaim(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}
