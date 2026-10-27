import { createDefaultApprovalPolicy, type TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { createActivityRecorder } from "@studix/observability";
import { createLogger } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_LIMITS } from "../src/gateway-config.ts";
import { createMcpGateway } from "../src/mcp-gateway.ts";
import type { ConnectorRepository } from "../src/registry/connector-types.ts";
import { createStaticSecretResolver } from "../src/testing/index.ts";
import { createFakeMcpClient, FAKE_TOOLS } from "./fake-mcp-client.ts";
import { OUTBOUND_TOKEN, SECRET_REF } from "./gateway-test-harness.ts";

const db = withTestDatabase();

async function provision(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: slug, slug },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: `usr_${slug}`, role: "owner" },
  };
}

function gatewayOnPostgres(secrets: ReturnType<typeof createStaticSecretResolver>) {
  const repos = db.current.repos;
  // Compile-time drift check: the Postgres repository must satisfy the gateway's port.
  const connectors: ConnectorRepository = repos.connectors;
  const logs: string[] = [];
  const logger = createLogger(
    { component: "mcp-gateway-it" },
    { level: "debug", write: (l) => logs.push(l) },
  );
  const client = createFakeMcpClient(FAKE_TOOLS);
  const gateway = createMcpGateway({
    connectors,
    approvals: repos.approvals,
    audit: repos.audit,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    secrets,
    config: { limits: DEFAULT_GATEWAY_LIMITS, insecureHosts: [], selfOrigins: ["https://app.studix.test"] },
    client,
    activity: createActivityRecorder(repos.activity, { logger }),
    logger,
  });
  return { gateway, client, logs };
}

describe("connector registry on Postgres", () => {
  it("persists connectors per workspace, re-authorizes from stored state and never stores the secret", async () => {
    const a = await provision("gw-a");
    const b = await provision("gw-b");
    const secrets = createStaticSecretResolver({ [a.workspaceId]: { [SECRET_REF]: OUTBOUND_TOKEN } });
    const { gateway, client, logs } = gatewayOnPostgres(secrets);

    const view = await gateway.connectors.add(
      { tenant: a },
      {
        name: "brandkit",
        url: "https://tools.example.com/mcp",
        secretRef: SECRET_REF,
        toolPolicy: { allow: ["brand_lookup", "echo"], deny: [] },
      },
    );
    await expect(
      gateway.connectors.add({ tenant: a }, { name: "brandkit", url: "https://other.example.com/mcp" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Same connector name in another workspace is independent.
    await gateway.connectors.add({ tenant: b }, { name: "brandkit", url: "https://tools.example.com/mcp" });

    const refreshed = await gateway.connectors.refresh({ tenant: a }, view.id);
    expect(refreshed.result).toMatchObject({ ok: true, toolCount: FAKE_TOOLS.length });
    expect(refreshed.result.at).toBeInstanceOf(Date);

    const stored = await db.current.repos.connectors.get(a, view.id);
    expect(stored).toMatchObject({ secretRef: SECRET_REF, version: 2, status: "enabled" });
    expect(await db.current.repos.connectors.get(b, view.id)).toBeUndefined();

    const ok = await gateway.execute({ tenant: a }, { tool: "brandkit.echo", arguments: { text: "hi" } });
    expect(ok.data.outcome).toBe("succeeded");
    expect(client.calls[0]?.target.credential?.headers.authorization).toBe(`Bearer ${OUTBOUND_TOKEN}`);
    await expect(gateway.execute({ tenant: b }, { tool: "brandkit.echo" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await gateway.connectors.setToolPolicy({ tenant: a }, view.id, { allow: ["brand_lookup"], deny: [] });
    await expect(gateway.execute({ tenant: a }, { tool: "brandkit.echo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await gateway.connectors.revoke({ tenant: a }, view.id);
    const revoked = await db.current.repos.connectors.get(a, view.id);
    expect(revoked).toMatchObject({ status: "revoked", tools: [] });
    expect(revoked?.secretRef).toBeUndefined();

    const audits = await db.current.repos.audit.list(a, { limit: 100 });
    const actions = audits.items.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "connector.added",
        "connector.refreshed",
        "connector.tool.executed",
        "connector.tool.denied",
        "connector.policy_updated",
        "connector.revoked",
      ]),
    );
    const activity = await db.current.repos.activity.list(a, { limit: 100 });
    const surface = JSON.stringify({ audits, activity, logs });
    expect(surface).not.toContain(SECRET_REF);
    expect(surface).not.toContain(OUTBOUND_TOKEN);
    // B only sees its own registration and its own refused attempt, nothing from workspace A.
    expect((await db.current.repos.audit.list(b, { limit: 100 })).items.map((e) => e.action).sort()).toEqual([
      "connector.added",
      "connector.tool.denied",
    ]);
  });
});
