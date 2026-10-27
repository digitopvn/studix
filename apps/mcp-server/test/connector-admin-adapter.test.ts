import { testTenant } from "@studix/core/testing";
import type { ConnectorAdmin, ConnectorView } from "@studix/mcp-gateway";
import { describe, expect, it } from "vitest";
import { createConnectorAdminAdapter } from "../src/connector-admin-adapter.ts";

const at = new Date("2026-10-27T00:00:00Z");
function view(over: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "con_1",
    name: "brand",
    url: "https://brand.example/mcp",
    transport: "streamable-http",
    status: "enabled",
    hasCredential: false,
    toolPolicy: { allow: ["brand_lookup"], deny: [] },
    toolCount: 2,
    version: 3,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function adapter(admin: Partial<ConnectorAdmin>) {
  const tools = [{ name: "brand_lookup" }, { name: "echo" }];
  return createConnectorAdminAdapter({
    admin: admin as ConnectorAdmin,
    connectors: { get: async () => ({ tools }) as never },
  });
}

describe("connector admin adapter", () => {
  it("maps gateway records to dashboard views with a text error and an error status", async () => {
    const failed = view({
      lastTest: {
        ok: false,
        at,
        latencyMs: 5,
        error: { code: "UNAVAILABLE", message: "refused", retryable: true },
      },
    });
    const port = adapter({ list: async () => [view(), view({ status: "revoked" }), failed] });
    const items = await port.list(testTenant());
    expect(items.map((i) => i.status)).toEqual(["active", "disabled", "error"]);
    expect(items[2]).toMatchObject({ lastError: "refused", lastCheckedAt: at });
    expect(JSON.stringify(items)).not.toContain("toolPolicy");
  });

  it("tests a connector by refreshing it and lists qualified tool names", async () => {
    const ok = adapter({
      refresh: async () => ({ connector: view(), result: { ok: true, at, latencyMs: 3, toolCount: 2 } }),
    });
    expect(await ok.test(testTenant(), "con_1")).toEqual({
      ok: true,
      toolCount: 2,
      tools: ["brand.brand_lookup", "brand.echo"],
    });
    const down = adapter({
      refresh: async () => ({
        connector: view(),
        result: { ok: false, at, latencyMs: 3, error: { code: "TIMEOUT", message: "slow", retryable: true } },
      }),
    });
    expect(await down.test(testTenant(), "con_1")).toEqual({ ok: false, error: "slow" });
  });
});
