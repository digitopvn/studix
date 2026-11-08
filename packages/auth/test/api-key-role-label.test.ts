import { PERMISSIONS, type Permission, ROLE_PERMISSIONS } from "@studix/core";
import { describe, expect, it } from "vitest";
import { toApiKeyView } from "../src/api-key-service.ts";

function labelOf(scopes: Permission[]) {
  const key = {
    id: "key_1",
    organizationId: "org_1",
    workspaceId: "ws_1",
    name: "k",
    prefix: "stx_x",
    hash: "h",
    scopes,
    createdBy: { type: "user", id: "u" },
    createdAt: new Date(0),
  } as unknown as Parameters<typeof toApiKeyView>[0];
  return toApiKeyView(key, new Date(1)).role;
}

describe("api key role label", () => {
  it("labels an operator key with or without the log permission it could not have held before", () => {
    const withoutSystem = [...ROLE_PERMISSIONS.operator].filter((p) => p !== "logs:system:read");
    expect(labelOf(withoutSystem)).toBe("operator");
    expect(labelOf(withoutSystem.filter((p) => p !== "logs:read"))).toBe("operator");
  });

  it("keeps owner and admin keys apart by logs:read", () => {
    expect(labelOf([...ROLE_PERMISSIONS.owner])).toBe("owner");
    expect(labelOf([...ROLE_PERMISSIONS.admin])).toBe("admin");
    expect(labelOf(PERMISSIONS.filter((p) => p === "project:read"))).toBe("custom");
  });
});
