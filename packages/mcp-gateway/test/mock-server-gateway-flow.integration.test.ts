import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { withActor } from "@studix/core/testing";
import { type MockMcpServer, startMockMcpServer } from "@studix/mock-mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_DEPTH_HEADER, parseGatewayDepth } from "../src/client/gateway-depth.ts";
import { type MetaToolEnvelope, registerGatewayMetaTools } from "../src/meta-tools/gateway-meta-tools.ts";
import {
  createGatewayHarness,
  INBOUND_KEY,
  OUTBOUND_TOKEN,
  observableSurface,
  SECRET_REF,
} from "./gateway-test-harness.ts";

let mock: MockMcpServer;

beforeAll(async () => {
  mock = await startMockMcpServer({ requiredBearer: OUTBOUND_TOKEN });
});
afterAll(async () => {
  await mock.close();
});

async function registeredGateway() {
  const h = createGatewayHarness();
  const added = await h.gateway.connectors.add(h.call(h.tenantA), {
    name: "brandkit",
    url: mock.url,
    secretRef: SECRET_REF,
    toolPolicy: { allow: ["brand_lookup", "echo", "weather_report", "oversized_schema"], deny: [] },
  });
  return { h, connectorId: added.id };
}

describe("gateway against a real Streamable HTTP MCP server", () => {
  it("registers, refreshes, searches, inspects and executes a read-only tool", async () => {
    const { h, connectorId } = await registeredGateway();
    const a = h.call(h.tenantA, { jobId: "job_e2e" });
    const refreshed = await h.gateway.connectors.refresh(a, connectorId);
    expect(refreshed.result).toMatchObject({ ok: true, toolCount: 7 });

    const search = await h.gateway.search(a, { query: "brand colors" });
    expect(search.data.results[0]).toMatchObject({ tool: "brandkit.brand_lookup", readOnly: true });
    expect(search.data.results.map((r) => r.tool)).not.toContain("brandkit.create_note");

    const inspected = await h.gateway.inspect(a, { tool: "brandkit.brand_lookup" });
    expect(inspected.data.inputSchema).toMatchObject({ type: "object" });

    const executed = await h.gateway.execute(a, {
      tool: "brandkit.brand_lookup",
      arguments: { name: "Sương Mai" },
    });
    expect(executed.data).toMatchObject({ outcome: "succeeded", mutating: false, attempts: 1 });
    expect(executed.data.result.structuredContent).toMatchObject({ tagline: "Đánh thức buổi sáng" });
    expect(mock.invocations("brand_lookup")).toBeGreaterThanOrEqual(1);

    const schema = await h.gateway.inspect(a, { tool: "brandkit.oversized_schema" });
    expect(schema.data.flags).toContain("schema-truncated");
    const weather = await h.gateway.search(a, { query: "weather" });
    expect(weather.data.results[0]?.flags).toContain("suspicious-instructions");

    const audits = await h.audit.list(h.tenantA, {
      subjectType: "connector_tool",
      subjectId: "brandkit.brand_lookup",
    });
    expect(audits.items[0]).toMatchObject({
      action: "connector.tool.executed",
      data: { verdict: "granted", outcome: "succeeded", resultBytes: expect.any(Number) },
    });
  });

  it("serves only the three meta-tools over /mcp and keeps inbound and outbound credentials apart", async () => {
    const { h, connectorId } = await registeredGateway();
    await h.gateway.connectors.refresh(h.call(h.tenantA), connectorId);
    const inboundActor = withActor(h.tenantA, {
      type: "apiKey",
      id: "key_inbound01",
      scopes: ["workspace:read", "project:write"],
    });
    // Stand-in for the Studix /mcp app: authenticate the inbound key, then hand only the tenant to the gateway.
    const studixMcp = createMcpHandler((ctx) => {
      const headers = ctx.requestInfo?.headers;
      if (headers?.get("authorization") !== `Bearer ${INBOUND_KEY}`) throw new Error("unauthenticated");
      const server = new McpServer({ name: "studix-test", version: "0.0.0" });
      registerGatewayMetaTools(server, h.gateway, {
        context: () => ({
          tenant: inboundActor,
          depth: parseGatewayDepth(headers.get(GATEWAY_DEPTH_HEADER) ?? undefined),
        }),
      });
      return server;
    });
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://app.studix.test/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${INBOUND_KEY}` } },
        fetch: (input, init) => studixMcp.fetch(new Request(input, init)),
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "studix_tool_execute",
        "studix_tool_inspect",
        "studix_tool_search",
      ]);
      const before = mock.requests.length;
      const result = await client.callTool({
        name: "studix_tool_execute",
        arguments: { tool: "brandkit.echo", arguments: { text: "hello" } },
      });
      const envelope = result.structuredContent as unknown as MetaToolEnvelope;
      expect(envelope.status).toBe("succeeded");

      const denied = await client.callTool({
        name: "studix_tool_execute",
        arguments: { tool: "brandkit.create_note", arguments: { title: "x" } },
      });
      expect(denied.isError).toBe(true);
      expect((denied.structuredContent as unknown as MetaToolEnvelope).error?.code).toBe("FORBIDDEN");

      const outbound = mock.requests.slice(before).filter((r) => r.path === "/mcp");
      expect(outbound.length).toBeGreaterThan(0);
      for (const request of outbound) {
        expect(request.headers.authorization).toBe(`Bearer ${OUTBOUND_TOKEN}`);
        expect(request.headers[GATEWAY_DEPTH_HEADER]).toBe("1");
        expect(JSON.stringify(request.headers)).not.toContain(INBOUND_KEY);
      }
      const surface = await observableSurface(h, [tools, result, denied]);
      expect(surface).not.toContain(OUTBOUND_TOKEN);
      expect(surface).not.toContain(SECRET_REF);
      expect(surface).not.toContain(INBOUND_KEY);
    } finally {
      await client.close();
    }
  });

  it("refuses a nested execute arriving with a gateway depth header", async () => {
    const { h, connectorId } = await registeredGateway();
    await h.gateway.connectors.refresh(h.call(h.tenantA), connectorId);
    const before = mock.invocations("echo");
    await expect(
      h.gateway.execute(h.call(h.tenantA, { depth: parseGatewayDepth("1") }), { tool: "brandkit.echo" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mock.invocations("echo")).toBe(before);
  });
});
