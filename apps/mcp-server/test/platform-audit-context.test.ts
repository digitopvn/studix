import type { TenantContext, TenantDirectory } from "@studix/core";
import { describe, expect, it } from "vitest";
import { platformAuditContext } from "../src/platform-audit-context.ts";

const operator: TenantContext = {
  organizationId: "org_tenant",
  workspaceId: "wsp_tenant",
  actor: { type: "user", id: "usr_op", role: "operator" },
};

function directory(role: string): Pick<TenantDirectory, "listMemberships"> {
  return {
    listMemberships: async () =>
      [
        { member: { role: "owner" }, organization: { id: "org_tenant" }, workspace: { id: "wsp_tenant" } },
        { member: { role }, organization: { id: "org_platform" }, workspace: { id: "wsp_platform" } },
      ] as unknown as Awaited<ReturnType<TenantDirectory["listMemberships"]>>,
  };
}

describe("platform audit context", () => {
  it("keeps the session's workspace when no platform workspace is configured", () => {
    expect(platformAuditContext(undefined, directory("operator"))).toBeUndefined();
  });

  it("moves platform events to the platform workspace, never the selected tenant's", async () => {
    const resolve = platformAuditContext("wsp_platform", directory("operator"));
    await expect(resolve?.(operator)).resolves.toEqual({
      organizationId: "org_platform",
      workspaceId: "wsp_platform",
      actor: operator.actor,
    });
  });

  it("refuses an operator without the operator role in the platform workspace", async () => {
    const resolve = platformAuditContext("wsp_platform", directory("admin"));
    await expect(resolve?.(operator)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
