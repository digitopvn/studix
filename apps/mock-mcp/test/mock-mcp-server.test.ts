import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupBrand } from "../src/brand-catalog.ts";
import { type MockMcpServer, startMockMcpServer } from "../src/mock-mcp-server.ts";

let mock: MockMcpServer;

async function connect(headers: Record<string, string> = {}) {
  const client = new Client({ name: "mock-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mock.url), { requestInit: { headers } }));
  return client;
}

beforeAll(async () => {
  mock = await startMockMcpServer({ requiredBearer: "mock-outbound-token" });
});
afterAll(async () => {
  await mock.close();
});

describe("mock MCP server", () => {
  it("lists the fixture tools and runs brand_lookup", async () => {
    const client = await connect({ Authorization: "Bearer mock-outbound-token" });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "brand_lookup",
        "create_note",
        "echo",
        "oversized_result",
        "oversized_schema",
        "slow_tool",
        "weather_report",
      ]);
      expect(tools.find((t) => t.name === "brand_lookup")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === "create_note")?.annotations?.readOnlyHint).toBe(false);

      const result = await client.callTool({ name: "brand_lookup", arguments: { name: "Sương Mai" } });
      expect(result.structuredContent).toMatchObject({ tagline: "Đánh thức buổi sáng", source: "catalog" });
      expect(mock.invocations("brand_lookup")).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("rejects requests without the expected bearer token", async () => {
    await expect(connect()).rejects.toThrow();
    expect(mock.requests.some((r) => r.path === "/mcp" && r.headers.authorization === undefined)).toBe(true);
  });

  it("generates deterministic palettes for unknown brands", () => {
    expect(lookupBrand("Acme").colors).toEqual(lookupBrand("  acme ").colors);
    expect(lookupBrand("Acme").source).toBe("generated");
  });
});
