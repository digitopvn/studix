import type { Permission } from "@studix/core";
import { StudixError } from "@studix/shared";
import type { Connector, ConnectorTool, ToolPolicy } from "../registry/connector-types.ts";

/** Actor permissions required for gateway operations (checked against the inbound key/session). */
export const GATEWAY_PERMISSIONS = {
  /** search + inspect */
  discover: "workspace:read",
  execute: "project:write",
  /** add / test / enable / disable / policy / revoke connectors (connectors hold credentials) */
  manage: "apikey:manage",
} as const satisfies Record<string, Permission>;

export const EMPTY_TOOL_POLICY: ToolPolicy = { allow: [], deny: [] };

const PATTERN = /^[A-Za-z0-9_.*-]{1,64}$/;
const MAX_PATTERNS = 100;

/** Validate an allow/deny policy supplied by an admin (boundary input). */
export function validateToolPolicy(policy: unknown): ToolPolicy {
  const p = policy as Partial<ToolPolicy> | undefined;
  const check = (list: unknown, field: string): string[] => {
    if (list === undefined) return [];
    if (
      !Array.isArray(list) ||
      list.length > MAX_PATTERNS ||
      !list.every((x) => typeof x === "string" && PATTERN.test(x))
    ) {
      throw new StudixError(
        "VALIDATION",
        `toolPolicy.${field} must be up to ${MAX_PATTERNS} tool names or * globs`,
      );
    }
    return [...new Set(list as string[])];
  };
  return { allow: check(p?.allow, "allow"), deny: check(p?.deny, "deny") };
}

export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (!pattern.includes("*")) return pattern === toolName;
  const regex = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.-]/g, "\\$&"))
      .join(".*")}$`,
  );
  return regex.test(toolName);
}

export type PermissionVerdict =
  | { allowed: true; reason: "granted" }
  | {
      allowed: false;
      reason: "connector-disabled" | "connector-revoked" | "tool-denied" | "tool-not-granted";
    };

/**
 * Permission store decision for one tool, from current connector state only. Deny wins over allow, and a
 * tool not explicitly granted is denied. Downstream annotations play no part in granting access.
 */
export function evaluateToolPermission(connector: Connector, toolName: string): PermissionVerdict {
  if (connector.status === "revoked") return { allowed: false, reason: "connector-revoked" };
  if (connector.status !== "enabled") return { allowed: false, reason: "connector-disabled" };
  if (connector.toolPolicy.deny.some((p) => matchesToolPattern(p, toolName))) {
    return { allowed: false, reason: "tool-denied" };
  }
  if (connector.toolPolicy.allow.some((p) => matchesToolPattern(p, toolName))) {
    return { allowed: true, reason: "granted" };
  }
  return { allowed: false, reason: "tool-not-granted" };
}

/**
 * Whether a tool counts as mutating. Only an explicit read-only, non-destructive hint makes a tool
 * read-only; a missing hint is treated as mutating (no auto-retry, approval required).
 */
export function isMutatingTool(tool: ConnectorTool): boolean {
  return !(tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint !== true);
}
