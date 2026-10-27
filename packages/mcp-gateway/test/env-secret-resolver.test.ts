import type { TenantContext } from "@studix/core";
import { describe, expect, it } from "vitest";
import { createEnvSecretResolver } from "../src/secrets/secret-resolver.ts";

const REF = "env:STUDIX_CONNECTOR_SECRET_BRAND";
const ctx = (workspaceId: string): TenantContext => ({
  organizationId: "org_1",
  workspaceId,
  actor: { type: "user", id: "usr_1", role: "owner" },
});
const owner = (url: string) => ({ connectorId: "con_1", connectorName: "brand", url });

const resolver = (bound = true) =>
  createEnvSecretResolver({
    env: {
      STUDIX_CONNECTOR_SECRET_BRAND: "operator-token",
      ...(bound
        ? {
            STUDIX_CONNECTOR_SECRET_BRAND_WORKSPACES: "ws_ops, ws_brand",
            STUDIX_CONNECTOR_SECRET_BRAND_ORIGIN: "https://brand.example.com",
          }
        : {}),
    },
  });

const code = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "resolved";
};

describe("env secret resolver binding", () => {
  it("resolves for a granted workspace and origin", async () => {
    const credential = await resolver().resolve(ctx("ws_brand"), owner("https://brand.example.com/mcp"), REF);
    expect(credential.headers.authorization).toBe("Bearer operator-token");
  });

  it("refuses a workspace that was not granted the secret", async () => {
    const r = resolver();
    expect(
      await code(() => r.authorize(ctx("ws_attacker"), { url: "https://brand.example.com/mcp" }, REF)),
    ).toBe("FORBIDDEN");
    expect(await code(() => r.resolve(ctx("ws_attacker"), owner("https://brand.example.com/mcp"), REF))).toBe(
      "FORBIDDEN",
    );
  });

  it("never sends the token to another origin, even for a granted workspace", async () => {
    const r = resolver();
    expect(await code(() => r.resolve(ctx("ws_brand"), owner("https://attacker.example.net/mcp"), REF))).toBe(
      "FORBIDDEN",
    );
    expect(await code(() => r.resolve(ctx("ws_brand"), owner("http://brand.example.com/mcp"), REF))).toBe(
      "FORBIDDEN",
    );
  });

  it("fails closed when the secret has no binding", async () => {
    expect(
      await code(() => resolver(false).resolve(ctx("ws_brand"), owner("https://brand.example.com/mcp"), REF)),
    ).toBe("FORBIDDEN");
  });

  it("rejects references to the binding variables themselves", async () => {
    const r = resolver();
    expect(
      await code(() => r.resolve(ctx("ws_brand"), owner("https://brand.example.com/mcp"), `${REF}_ORIGIN`)),
    ).toBe("VALIDATION");
  });
});
