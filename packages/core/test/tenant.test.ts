import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  assertPermission,
  assertRelativeStorageKey,
  assertTenantContext,
  can,
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
