import { withActor } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import { createFakeMcpClient, FAKE_TOOLS } from "./fake-mcp-client.ts";
import {
  createGatewayHarness,
  type GatewayHarness,
  OUTBOUND_TOKEN,
  observableSurface,
  rejection,
  SECRET_REF,
} from "./gateway-test-harness.ts";

async function setup(allow = ["brand_lookup", "echo", "create_note", "weather_report", "huge_schema"]) {
  const client = createFakeMcpClient(FAKE_TOOLS);
  const h = createGatewayHarness({ client });
  const view = await h.gateway.connectors.add(h.call(h.tenantA), {
    name: "brandkit",
    url: "https://tools.example.com/mcp",
    secretRef: SECRET_REF,
    toolPolicy: { allow, deny: [] },
  });
  const refreshed = await h.gateway.connectors.refresh(h.call(h.tenantA), view.id);
  expect(refreshed.result.ok).toBe(true);
  return { h, client, connectorId: view.id };
}

const names = async (h: GatewayHarness, query = "") =>
  (await h.gateway.search(h.call(h.tenantA), { query, limit: 25 })).data.results.map((r) => r.tool);

describe("gateway discovery and authorization", () => {
  it("searches permitted tools by qualified name and ranks exact matches first", async () => {
    const { h } = await setup();
    const result = await h.gateway.search(h.call(h.tenantA), { query: "brand_lookup" });
    expect(result.data.results[0]).toMatchObject({ tool: "brandkit.brand_lookup", readOnly: true });
    expect(result.next[0]).toMatchObject({
      tool: "studix_tool_inspect",
      arguments: { tool: "brandkit.brand_lookup" },
    });
    expect(await names(h, "brnd lookup")).toContain("brandkit.brand_lookup");
    // delete_all is not granted (deny by default), so it never appears.
    expect(await names(h)).not.toContain("brandkit.delete_all");
    await expect(h.gateway.execute(h.call(h.tenantA), { tool: "brandkit.delete_all" })).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
  });

  it("inspect returns the bounded schema, permission and availability", async () => {
    const { h } = await setup();
    const { data } = await h.gateway.inspect(h.call(h.tenantA), { tool: "brandkit.brand_lookup" });
    expect(data.inputSchema).toMatchObject({ properties: { name: { type: "string" } } });
    expect(data.permission).toEqual({ allowed: true, requiresApproval: false });
    expect(data.availability.status).toBe("enabled");
    const huge = await h.gateway.inspect(h.call(h.tenantA), { tool: "brandkit.huge_schema" });
    expect(huge.data.flags).toContain("schema-truncated");
    expect(JSON.stringify(huge.data.inputSchema).length).toBeLessThan(500);
  });

  it("isolates tenants: workspace B cannot see, inspect, execute or administer A's connector", async () => {
    const { h, connectorId } = await setup();
    const b = h.call(h.tenantB);
    expect((await h.gateway.search(b, { query: "" })).data.results).toEqual([]);
    await expect(h.gateway.inspect(b, { tool: "brandkit.brand_lookup" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(h.gateway.execute(b, { tool: "brandkit.brand_lookup" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(h.gateway.connectors.disable(b, connectorId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.gateway.connectors.refresh(b, connectorId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await h.gateway.connectors.list(b)).toEqual([]);
  });

  it("re-authorizes at execute: a tool denied after search is refused and disappears from search", async () => {
    const { h, connectorId, client } = await setup();
    expect(await names(h)).toContain("brandkit.echo");
    await h.gateway.connectors.setToolPolicy(h.call(h.tenantA), connectorId, {
      allow: ["*"],
      deny: ["echo"],
    });
    const err = await rejection(
      h.gateway.execute(h.call(h.tenantA), { tool: "brandkit.echo", arguments: { text: "x" } }),
    );
    expect(err).toMatchObject({ code: "FORBIDDEN" });
    expect(err.details?.traceId).toBeTypeOf("string");
    expect(await names(h)).not.toContain("brandkit.echo");
    expect(client.calls).toHaveLength(0);
    const denied = await h.audit.list(h.tenantA, {
      subjectType: "connector_tool",
      subjectId: "brandkit.echo",
    });
    expect(denied.items[0]).toMatchObject({
      action: "connector.tool.denied",
      data: { verdict: "tool-denied" },
    });
  });

  it("refuses disabled and revoked connectors; revoke is terminal and drops the secretRef", async () => {
    const { h, connectorId } = await setup();
    const a = h.call(h.tenantA);
    await h.gateway.connectors.disable(a, connectorId);
    expect(await names(h)).toEqual([]);
    await expect(h.gateway.execute(a, { tool: "brandkit.echo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(h.gateway.inspect(a, { tool: "brandkit.echo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await h.gateway.connectors.enable(a, connectorId);
    expect(await names(h)).toContain("brandkit.echo");
    const revoked = await h.gateway.connectors.revoke(a, connectorId);
    expect(revoked).toMatchObject({ status: "revoked", hasCredential: false, toolCount: 0 });
    expect((await h.connectors.get(h.tenantA, connectorId))?.secretRef).toBeUndefined();
    await expect(h.gateway.execute(a, { tool: "brandkit.echo" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(h.gateway.connectors.enable(a, connectorId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("checks actor permissions: viewers cannot execute, keys without apikey:manage cannot administer", async () => {
    const { h } = await setup();
    const viewer = withActor(h.tenantA, { type: "user", id: "usr_viewer", role: "viewer" });
    expect((await h.gateway.search(h.call(viewer), { query: "echo" })).data.results.length).toBeGreaterThan(
      0,
    );
    await expect(h.gateway.execute(h.call(viewer), { tool: "brandkit.echo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const key = withActor(h.tenantA, {
      type: "apiKey",
      id: "key_1",
      scopes: ["workspace:read", "project:write"],
    });
    await expect(
      h.gateway.connectors.add(h.call(key), { name: "other", url: "https://x.example.com/mcp" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses nested execution arriving through another gateway hop (recursion guard)", async () => {
    const { h, client } = await setup();
    await expect(
      h.gateway.execute(h.call(h.tenantA, { depth: 1 }), { tool: "brandkit.echo" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(client.calls).toHaveLength(0);
    await expect(
      h.gateway.connectors.add(h.call(h.tenantA), { name: "loop", url: "https://app.studix.test/mcp" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("sends only the outbound credential downstream and never leaks secretRef, token or inbound key", async () => {
    const { h, client } = await setup();
    const keyActor = withActor(h.tenantA, {
      type: "apiKey",
      id: "key_inbound01",
      scopes: ["workspace:read", "project:write"],
    });
    const outputs: unknown[] = [];
    outputs.push(await h.gateway.connectors.list(h.call(h.tenantA)));
    outputs.push(await h.gateway.search(h.call(keyActor), { query: "" }));
    outputs.push(await h.gateway.inspect(h.call(keyActor), { tool: "brandkit.brand_lookup" }));
    outputs.push(
      await h.gateway.execute(h.call(keyActor), { tool: "brandkit.brand_lookup", arguments: { name: "A" } }),
    );
    client.setBehavior(async () => {
      throw new Error(`upstream rejected token ${OUTBOUND_TOKEN}`);
    });
    outputs.push(await rejection(h.gateway.execute(h.call(h.tenantA), { tool: "brandkit.echo" })));

    const target = client.calls[0]!.target;
    expect(target.credential?.headers).toEqual({ authorization: `Bearer ${OUTBOUND_TOKEN}` });
    expect(JSON.stringify(target)).not.toContain("stx_");
    expect(h.secrets.resolutions.every((r) => r.workspaceId === h.tenantA.workspaceId)).toBe(true);

    const surface = await observableSurface(h, outputs);
    expect(surface).not.toContain(SECRET_REF);
    expect(surface).not.toContain(OUTBOUND_TOKEN);
    expect(surface).not.toContain("Bearer ");
  });
});
