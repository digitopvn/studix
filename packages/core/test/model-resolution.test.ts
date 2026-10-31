import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  applicablePreferences,
  type ModelChoice,
  type ModelPreference,
  type ProviderConnection,
  resolveModelSelection,
} from "../src/index.ts";

const now = new Date("2026-10-31T00:00:00Z");
const actor = { type: "user", id: "u1" } as const;
const base = { organizationId: "o", workspaceId: "w", createdAt: now, updatedAt: now };

function connection(over: Partial<ProviderConnection> & { id: string }): ProviderConnection {
  return {
    ...base,
    providerId: "anthropic",
    authMethod: "api_key",
    owner: { kind: "workspace" },
    status: "connected",
    billingSource: "usage-based",
    runtimes: ["pi"],
    createdBy: actor,
    ...over,
  };
}

function preference(over: Partial<ModelPreference> & { id: string; primary: ModelChoice }): ModelPreference {
  return { ...base, scope: { level: "workspace" }, runtime: "pi", fallbacks: [], updatedBy: actor, ...over };
}

const ok = () => ({ ok: true }) as const;
const claude = (connectionId: string): ModelChoice => ({
  providerId: "anthropic",
  modelId: "m1",
  connectionId,
});
const request = { runtime: "pi", userId: "u1", workflow: "video", stage: "plan", now } as const;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof StudixError ? err.code : "other";
  }
  return undefined;
}

describe("model resolution", () => {
  it("prefers stage over workflow over user over workspace", () => {
    const prefs = [
      preference({ id: "ws", primary: claude("c") }),
      preference({ id: "user", scope: { level: "user", userId: "u1" }, primary: claude("c") }),
      preference({ id: "wf", scope: { level: "workflow", workflow: "video" }, primary: claude("c") }),
      preference({
        id: "st",
        scope: { level: "stage", workflow: "video", stage: "plan" },
        primary: claude("c"),
      }),
      preference({ id: "other", scope: { level: "user", userId: "u2" }, primary: claude("c") }),
      preference({
        id: "wrong-stage",
        scope: { level: "stage", workflow: "video", stage: "qa" },
        primary: claude("c"),
      }),
    ];
    expect(applicablePreferences(prefs, request).map((p) => p.id)).toEqual(["st", "wf", "user", "ws"]);
    const snap = resolveModelSelection(prefs, [connection({ id: "c" })], request, ok);
    expect(snap).toMatchObject({
      source: "stage",
      usedFallback: false,
      connectionId: "c",
      billingSource: "usage-based",
    });
  });

  it("does not fall through to a less specific preference when the specific one is unusable", () => {
    const prefs = [
      preference({ id: "ws", primary: claude("good") }),
      preference({ id: "wf", scope: { level: "workflow", workflow: "video" }, primary: claude("bad") }),
    ];
    const conns = [connection({ id: "good" }), connection({ id: "bad", status: "expired" })];
    expect(code(() => resolveModelSelection(prefs, conns, request, ok))).toBe("UNAUTHENTICATED");
  });

  it("uses only explicitly listed fallbacks and marks them", () => {
    const prefs = [preference({ id: "p", primary: claude("bad"), fallbacks: [claude("good")] })];
    const conns = [
      connection({ id: "bad", status: "revoked" }),
      connection({ id: "good" }),
      connection({ id: "unlisted" }),
    ];
    expect(resolveModelSelection(prefs, conns, request, ok)).toMatchObject({
      connectionId: "good",
      source: "fallback",
      usedFallback: true,
    });
  });

  it("rejects another user's connection, wrong runtime, wrong provider and expired credentials", () => {
    const run = (c: ProviderConnection, choice: ModelChoice = claude(c.id)) =>
      code(() => resolveModelSelection([preference({ id: "p", primary: choice })], [c], request, ok));
    expect(run(connection({ id: "c", owner: { kind: "user", userId: "u2" } }))).toBe("UNAUTHENTICATED");
    expect(run(connection({ id: "c", runtimes: ["claude-agent-sdk"] }))).toBe("UNAVAILABLE");
    expect(run(connection({ id: "c", providerId: "openai" }), claude("c"))).toBe("UNAVAILABLE");
    expect(run(connection({ id: "c", expiresAt: new Date(now.getTime() - 1) }))).toBe("UNAUTHENTICATED");
    expect(run(connection({ id: "c", owner: { kind: "user", userId: "u1" } }))).toBeUndefined();
  });

  it("reports catalog unavailability and a missing configuration", () => {
    const prefs = [preference({ id: "p", primary: claude("c") })];
    const gone = () => ({ ok: false, reason: "model removed" }) as const;
    expect(code(() => resolveModelSelection(prefs, [connection({ id: "c" })], request, gone))).toBe(
      "UNAVAILABLE",
    );
    expect(code(() => resolveModelSelection([], [], request, ok))).toBe("UNAVAILABLE");
  });

  it("never carries secrets in the snapshot", () => {
    const snap = resolveModelSelection(
      [preference({ id: "p", primary: claude("c") })],
      [connection({ id: "c", secretRef: "sec_123", maskedHint: "sk-…a1b2" })],
      request,
      ok,
    );
    expect(JSON.stringify(snap)).not.toMatch(/sec_123|sk-/);
  });
});
