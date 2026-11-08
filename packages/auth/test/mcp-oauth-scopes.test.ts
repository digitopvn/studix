import { describe, expect, it } from "vitest";
import { resourceMetadataUrlFor } from "../src/mcp-oauth.ts";
import { MCP_SUPPORTED_SCOPES, parseScopeClaim, permissionsForScopes } from "../src/mcp-oauth-scopes.ts";

describe("mcp oauth scopes", () => {
  it("maps scopes to permissions and ignores unknown ones", () => {
    expect(permissionsForScopes(["studix:read"])).toEqual([
      "workspace:read",
      "project:read",
      "asset:read",
      "skill:read",
    ]);
    expect(permissionsForScopes(["studix:read"])).not.toContain("skill:write");
    expect(permissionsForScopes(["studix:write"])).toContain("skill:write");
    expect(permissionsForScopes(["offline_access", "admin"])).toEqual([]);
    expect(permissionsForScopes(["studix:write"])).not.toContain("approval:decide");
    expect(permissionsForScopes(["studix:write"])).not.toContain("apikey:manage");
  });

  it("parses space separated and array scope claims", () => {
    expect(parseScopeClaim("studix:read  offline_access")).toEqual(["studix:read", "offline_access"]);
    expect(parseScopeClaim(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(parseScopeClaim(undefined)).toEqual([]);
  });

  it("advertises read, write and offline access", () => {
    expect(MCP_SUPPORTED_SCOPES).toEqual(["studix:read", "studix:write", "studix:logs", "offline_access"]);
  });

  it("inserts the resource path into the well-known metadata URL", () => {
    expect(resourceMetadataUrlFor("https://app.example.com/mcp")).toBe(
      "https://app.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(resourceMetadataUrlFor("https://app.example.com/")).toBe(
      "https://app.example.com/.well-known/oauth-protected-resource",
    );
  });
});
