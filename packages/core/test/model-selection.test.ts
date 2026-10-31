import { describe, expect, it } from "vitest";
import {
  connectionUsableBy,
  type ModelPreference,
  type ProviderConnection,
  resolveModelSelection,
  toPublicConnection,
} from "../src/index.ts";

const base = { organizationId: "org", workspaceId: "ws", createdAt: new Date(0), updatedAt: new Date(0) };
const pref = (
  over: Partial<ModelPreference> & Pick<ModelPreference, "id" | "scope" | "stage">,
): ModelPreference => ({
  ...base,
  runtime: "pi",
  connectionId: "pconn_1",
  provider: "anthropic",
  modelId: over.id,
  allowFallback: false,
  fallbacks: [],
  ...over,
});

const prefs = [
  pref({ id: "ws-default", scope: { type: "workspace" }, stage: "default" }),
  pref({ id: "ws-plan", scope: { type: "workspace" }, stage: "plan" }),
  pref({ id: "u1-default", scope: { type: "user", userId: "u1" }, stage: "default" }),
  pref({ id: "u1-plan", scope: { type: "user", userId: "u1" }, stage: "plan" }),
  pref({ id: "other-runtime", scope: { type: "workspace" }, stage: "qa", runtime: "claude-agent-sdk" }),
];

describe("resolveModelSelection precedence", () => {
  it("user stage > workspace stage > user default > workspace default", () => {
    const pick = (stage: string, userId?: string) =>
      resolveModelSelection(prefs, { runtime: "pi", stage, userId });
    expect(pick("plan", "u1")).toMatchObject({ source: "user-stage", preference: { id: "u1-plan" } });
    expect(pick("plan", "u2")).toMatchObject({ source: "workspace-stage", preference: { id: "ws-plan" } });
    expect(pick("qa", "u1")).toMatchObject({ source: "user-default", preference: { id: "u1-default" } });
    expect(pick("qa", "u2")).toMatchObject({ source: "workspace-default", preference: { id: "ws-default" } });
    expect(pick("qa")).toMatchObject({ source: "workspace-default" });
  });

  it("never crosses runtimes and returns undefined instead of guessing", () => {
    expect(resolveModelSelection(prefs, { runtime: "claude-agent-sdk", stage: "plan" })).toBeUndefined();
    expect(resolveModelSelection([], { runtime: "pi", stage: "plan" })).toBeUndefined();
  });
});

const conn = (over: Partial<ProviderConnection>): ProviderConnection => ({
  ...base,
  id: "pconn_1",
  provider: "anthropic",
  label: "k",
  authMethod: "api_key",
  owner: { type: "workspace" },
  status: "connected",
  billingSource: "usage-based",
  secretRef: "cred_1",
  runtimes: ["pi"],
  version: 1,
  createdBy: { type: "user", id: "u1" },
  ...over,
});

describe("connection access", () => {
  it("personal connections are usable only by their owner, workspace ones by anyone", () => {
    expect(connectionUsableBy(conn({}), "u2")).toBe(true);
    expect(connectionUsableBy(conn({ owner: { type: "user", userId: "u1" } }), "u1")).toBe(true);
    expect(connectionUsableBy(conn({ owner: { type: "user", userId: "u1" } }), "u2")).toBe(false);
    expect(connectionUsableBy(conn({ owner: { type: "user", userId: "u1" } }), undefined)).toBe(false);
  });

  it("only connected status is usable", () => {
    for (const status of [
      "connecting",
      "invalid",
      "expired",
      "restricted",
      "revoked",
      "requires_action",
      "unsupported",
    ] as const) {
      expect(connectionUsableBy(conn({ status }), "u1")).toBe(false);
    }
  });

  it("public projection drops the vault reference", () => {
    expect(JSON.stringify(toPublicConnection(conn({})))).not.toContain("cred_1");
    expect("secretRef" in toPublicConnection(conn({}))).toBe(false);
  });
});
