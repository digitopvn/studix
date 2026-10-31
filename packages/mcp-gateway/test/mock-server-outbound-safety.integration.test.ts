import { type MockMcpServer, startMockMcpServer } from "@studix/mock-mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayLimits } from "../src/gateway-config.ts";
import { createStubHostResolver } from "../src/testing/index.ts";
import { createConnectorUrlPolicy } from "../src/url-policy/connector-url-policy.ts";
import { createGatewayHarness, OUTBOUND_TOKEN, rejection, SECRET_REF } from "./gateway-test-harness.ts";

let mock: MockMcpServer;

beforeAll(async () => {
  mock = await startMockMcpServer({ requiredBearer: OUTBOUND_TOKEN });
});
afterAll(async () => {
  await mock.close();
});

async function connectorAt(url: string, limits: Partial<GatewayLimits> = {}, allow = ["*"]) {
  const h = createGatewayHarness({ limits });
  const view = await h.gateway.connectors.add(h.call(h.tenantA), {
    name: "brandkit",
    url,
    secretRef: SECRET_REF,
    toolPolicy: { allow, deny: [] },
  });
  return { h, id: view.id };
}

describe("outbound URL safety (SSRF)", () => {
  it("refuses private, metadata and plain-http public targets at registration", async () => {
    const h = createGatewayHarness();
    const add = (url: string) => h.gateway.connectors.add(h.call(h.tenantA), { name: "bad", url });
    await expect(add("https://10.0.0.8/mcp")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(add("https://169.254.169.254/latest/meta-data")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(add("http://tools.example.com/mcp")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await h.gateway.connectors.list(h.call(h.tenantA))).toEqual([]);
  });

  it("refuses a redirect to a private address and records the failed test", async () => {
    const { h, id } = await connectorAt(
      `${mock.origin}/redirect?to=${encodeURIComponent("http://10.0.0.8/mcp")}`,
    );
    const { result, connector } = await h.gateway.connectors.refresh(h.call(h.tenantA), id);
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(connector.toolCount).toBe(0);
  });

  it("pins the first DNS answer for a session and refuses a later rebinding answer", async () => {
    const host = "mock.rebind.test";
    const resolver = createStubHostResolver({
      [host]: [[{ address: "127.0.0.1", family: 4 }], [{ address: "169.254.169.254", family: 4 }]],
    });
    const urlPolicy = createConnectorUrlPolicy({ insecureHosts: [host], resolver });
    const h = createGatewayHarness({ urlPolicy });
    const view = await h.gateway.connectors.add(h.call(h.tenantA), {
      name: "rebind",
      url: `http://${host}:${mock.port}/mcp`,
      secretRef: SECRET_REF,
      toolPolicy: { allow: ["echo"], deny: [] },
    });
    const refreshed = await h.gateway.connectors.refresh(h.call(h.tenantA), view.id);
    expect(refreshed.result.ok).toBe(true);
    // One resolution for the whole session, although the MCP client made several HTTP requests.
    expect(resolver.calls).toEqual([host]);
    const before = mock.invocations("echo");
    await expect(h.gateway.execute(h.call(h.tenantA), { tool: "rebind.echo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mock.invocations("echo")).toBe(before);
  });
});

describe("downstream limits", () => {
  it("caps oversized results and refuses responses above the transport byte cap", async () => {
    const { h, id } = await connectorAt(mock.url, { maxResultBytes: 8_192 });
    await h.gateway.connectors.refresh(h.call(h.tenantA), id);
    const capped = await h.gateway.execute(h.call(h.tenantA), {
      tool: "brandkit.oversized_result",
      arguments: { bytes: 200_000 },
    });
    expect(capped.data.result).toMatchObject({ truncated: true });
    expect(capped.data.result.resultBytes).toBeLessThanOrEqual(8_192);
    expect(capped.data.result.originalBytes).toBeGreaterThan(200_000);

    const small = await connectorAt(mock.url, { maxResponseBytes: 1_000_000 });
    const smallRefresh = await small.h.gateway.connectors.refresh(small.h.call(small.h.tenantA), small.id);
    expect(smallRefresh.result.ok).toBe(true);
    const err = await rejection(
      small.h.gateway.execute(small.h.call(small.h.tenantA), {
        tool: "brandkit.oversized_result",
        arguments: { bytes: 2_000_000 },
      }),
    );
    expect(err.code).toBe("PROVIDER_ERROR");
  });

  it("times out slow tools", async () => {
    const { h, id } = await connectorAt(mock.url, { timeoutMs: 400 });
    await h.gateway.connectors.refresh(h.call(h.tenantA), id);
    const started = Date.now();
    const err = await rejection(
      h.gateway.execute(h.call(h.tenantA), { tool: "brandkit.slow_tool", arguments: { ms: 5_000 } }),
    );
    expect(err.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not retry an approved mutating call whose outcome is unknown", async () => {
    const { h, id } = await connectorAt(mock.url, { timeoutMs: 2_000 });
    await h.gateway.connectors.refresh(h.call(h.tenantA), id);
    const job = h.call(h.tenantA, { jobId: "job_note" });
    const request = { tool: "brandkit.create_note", arguments: { title: "Slow write", delayMs: 6_000 } };
    const pending = await rejection(h.gateway.execute(job, request));
    expect(pending.code).toBe("APPROVAL_REQUIRED");
    await h.approvals.decide(h.tenantA, pending.details?.approvalId as string, {
      status: "approved",
      decidedBy: { type: "user", id: "usr_reviewer" },
      decidedAt: h.clock.now(),
    });
    const before = mock.invocations("create_note");
    const err = await rejection(h.gateway.execute(job, request));
    expect(err).toMatchObject({ code: "TIMEOUT", retryable: false, details: { outcomeUnknown: true } });
    expect(mock.invocations("create_note")).toBe(before + 1);
  });
});
