import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  assertPermission,
  assertRelativeStorageKey,
  assertTenantContext,
  can,
  ROLE_PERMISSIONS,
  type TenantContext,
  tenantObjectKey,
} from "../src/index.ts";
import { testTenant } from "../src/testing/index.ts";

describe("authorization matrix", () => {
  it("maps roles to permissions", () => {
    expect(can({ type: "user", id: "u", role: "viewer" }, "project:read")).toBe(true);
    expect(can({ type: "user", id: "u", role: "viewer" }, "project:write")).toBe(false);
    expect(can({ type: "user", id: "u", role: "reviewer" }, "approval:decide")).toBe(true);
    expect(can({ type: "user", id: "u", role: "reviewer" }, "project:write")).toBe(false);
    expect(can({ type: "user", id: "u", role: "editor" }, "publish")).toBe(false);
    expect(can({ type: "user", id: "u", role: "owner" }, "publish")).toBe(true);
  });

  it("api keys only hold their scopes and system actors never approve", () => {
    expect(can({ type: "apiKey", id: "k", scopes: ["project:read"] }, "project:read")).toBe(true);
    expect(can({ type: "apiKey", id: "k", scopes: ["project:read"] }, "project:write")).toBe(false);
    expect(can({ type: "system", id: "worker" }, "project:write")).toBe(true);
    expect(can({ type: "system", id: "worker" }, "approval:decide")).toBe(false);
  });

  it("oauth actors hold only their scopes, never approve, never operator permissions", () => {
    const actor = { type: "oauth", id: "u", clientId: "c", scopes: ["project:read", "job:recover"] } as const;
    expect(can(actor, "project:read")).toBe(true);
    expect(can(actor, "project:write")).toBe(false);
    expect(can(actor, "approval:decide")).toBe(false);
    expect(can(actor, "job:recover")).toBe(false);
  });

  it("logs:read belongs to owners only; logs:system:read to no key, token, system actor or tenant role", () => {
    const role = (r: "operator" | "owner" | "admin" | "editor" | "reviewer" | "viewer") =>
      ({ type: "user", id: "u", role: r }) as const;
    expect(can(role("owner"), "logs:read")).toBe(true);
    for (const r of ["admin", "editor", "reviewer", "viewer"] as const) {
      expect(can(role(r), "logs:read")).toBe(false);
    }
    for (const r of ["owner", "admin", "editor", "reviewer", "viewer"] as const) {
      expect(can(role(r), "logs:system:read")).toBe(false);
    }
    expect(can(role("operator"), "logs:system:read")).toBe(true);
    expect(can({ type: "apiKey", id: "k", scopes: ["logs:read"] }, "logs:read")).toBe(true);
    expect(can({ type: "apiKey", id: "k", scopes: ["logs:system:read"] }, "logs:system:read")).toBe(false);
    const oauth = {
      type: "oauth",
      id: "u",
      clientId: "c",
      scopes: ["logs:system:read", "logs:read"],
    } as const;
    expect(can(oauth, "logs:system:read")).toBe(false);
    expect(can(oauth, "logs:read")).toBe(true);
    expect(can({ type: "system", id: "worker" }, "logs:system:read")).toBe(false);
  });

  it("gives admins every permission they had before log access existed, and nothing newer by default", () => {
    const admin = [...ROLE_PERMISSIONS.admin].sort();
    expect(admin).toEqual(
      [
        "workspace:read",
        "project:read",
        "project:write",
        "job:cancel",
        "job:retry",
        "asset:read",
        "asset:write",
        "skill:read",
        "skill:write",
        "media:exec",
        "approval:request",
        "approval:decide",
        "publish",
        "audit:read",
        "apikey:manage",
        "member:manage",
      ].sort(),
    );
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...admin, "logs:read"].sort());
  });

  it("assertPermission throws FORBIDDEN with a suggested action", () => {
    const ctx = testTenant({ scopes: ["project:read"] });
    expect(() => assertPermission(ctx, "project:write")).toThrow(StudixError);
    try {
      assertPermission(ctx, "project:write");
    } catch (err) {
      expect((err as StudixError).code).toBe("FORBIDDEN");
      expect((err as StudixError).suggestedAction).toContain("project:write");
    }
  });

  it("rejects incomplete tenant contexts", () => {
    expect(() => assertTenantContext(undefined)).toThrow(/Missing tenant context/);
    expect(() =>
      assertTenantContext({ organizationId: "o", workspaceId: "", actor: { type: "system", id: "s" } }),
    ).toThrow();
  });
});

describe("tenant object keys", () => {
  const ctx: TenantContext = testTenant({ organizationId: "org_a", workspaceId: "ws_a" });

  it("prefixes relative keys with the tenant", () => {
    expect(tenantObjectKey(ctx, "renders/rnd_1/final.mp4")).toBe(
      "orgs/org_a/workspaces/ws_a/renders/rnd_1/final.mp4",
    );
  });

  it.each(["", "/abs/key", "../ws_b/x", "a/../../b", "a//b", "a/./b", "a\\b", "a b"])("rejects %j", (key) => {
    expect(() => assertRelativeStorageKey(key)).toThrow(StudixError);
  });
});
