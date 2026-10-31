import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  applicablePreferences,
  assertSnapshotUsable,
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
const request = {
  organizationId: "o",
  workspaceId: "w",
  runtime: "pi",
  userId: "u1",
  workflow: "video",
  stage: "plan",
  now,
} as const;

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
      source: "workspace",
      preferenceId: "p",
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

  it("never mixes tenants", () => {
    const prefs = [preference({ id: "p", primary: claude("c") })];
    expect(
      code(() => resolveModelSelection(prefs, [connection({ id: "c", workspaceId: "other" })], request, ok)),
    ).toBe("UNAUTHENTICATED");
    expect(
      code(() =>
        resolveModelSelection(prefs, [connection({ id: "c", organizationId: "other" })], request, ok),
      ),
    ).toBe("UNAUTHENTICATED");
    const foreign = [preference({ id: "p", workspaceId: "other", primary: claude("c") })];
    expect(code(() => resolveModelSelection(foreign, [connection({ id: "c" })], request, ok))).toBe(
      "UNAVAILABLE",
    );
  });

  it("enforces workspace connection grants", () => {
    const prefs = [preference({ id: "p", primary: claude("c") })];
    const granted = connection({ id: "c", allowedUserIds: ["u2"] });
    expect(code(() => resolveModelSelection(prefs, [granted], request, ok))).toBe("UNAUTHENTICATED");
    expect(code(() => resolveModelSelection(prefs, [granted], { ...request, userId: undefined }, ok))).toBe(
      "UNAUTHENTICATED",
    );
    expect(
      code(() => resolveModelSelection(prefs, [granted], { ...request, userId: "u2" }, ok)),
    ).toBeUndefined();
    expect(
      code(() =>
        resolveModelSelection(prefs, [connection({ id: "c" })], { ...request, userId: undefined }, ok),
      ),
    ).toBeUndefined();
  });

  it("rejects ties at the same level", () => {
    const prefs = [
      preference({ id: "a", primary: claude("c") }),
      preference({ id: "b", primary: claude("c") }),
    ];
    expect(code(() => resolveModelSelection(prefs, [connection({ id: "c" })], request, ok))).toBe("CONFLICT");
  });

  it("rejects restricted, requires_action and the exact expiry instant", () => {
    const prefs = [preference({ id: "p", primary: claude("c") })];
    for (const c of [
      connection({ id: "c", status: "restricted" }),
      connection({ id: "c", status: "requires_action" }),
      connection({ id: "c", expiresAt: now }),
    ]) {
      expect(code(() => resolveModelSelection(prefs, [c], request, ok))).toBe("UNAUTHENTICATED");
    }
    expect(code(() => resolveModelSelection(prefs, [], request, ok))).toBe("UNAUTHENTICATED");
  });

  it("skips user-scope preferences without a user and keeps ids out of error details", () => {
    const prefs = [preference({ id: "u", scope: { level: "user", userId: "u1" }, primary: claude("c") })];
    expect(
      code(() =>
        resolveModelSelection(prefs, [connection({ id: "c" })], { ...request, userId: undefined }, ok),
      ),
    ).toBe("UNAVAILABLE");
    try {
      resolveModelSelection(
        [preference({ id: "p", primary: claude("secret-conn") })],
        [connection({ id: "secret-conn", owner: { kind: "user", userId: "u2" } })],
        request,
        ok,
      );
    } catch (err) {
      expect(JSON.stringify((err as StudixError).details)).not.toContain("secret-conn");
    }
  });

  it("re-checks a pinned snapshot before a rerun", () => {
    const snap = resolveModelSelection(
      [preference({ id: "p", primary: claude("c") })],
      [connection({ id: "c" })],
      request,
      ok,
    );
    expect(code(() => assertSnapshotUsable(snap, connection({ id: "c" }), request, ok))).toBeUndefined();
    expect(
      code(() => assertSnapshotUsable(snap, connection({ id: "c", status: "revoked" }), request, ok)),
    ).toBe("UNAUTHENTICATED");
    expect(code(() => assertSnapshotUsable(snap, undefined, request, ok))).toBe("UNAUTHENTICATED");
    expect(code(() => assertSnapshotUsable(snap, connection({ id: "other" }), request, ok))).toBe(
      "UNAUTHENTICATED",
    );
  });
});
