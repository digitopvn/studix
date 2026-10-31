import { randomBytes } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { schema } from "@studix/database";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError, type StudixErrorPayload } from "@studix/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ProviderKeyTester, ProviderKeyTestResult } from "../src/anthropic-key-tester.ts";
import { createProviderConnectionService } from "../src/provider-connection-service.ts";
import { createSecretBox } from "../src/secret-box.ts";

const db = withTestDatabase();
const KEY_A = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa-AAAA";
const KEY_B = "sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbb-BBBB";
const BAD = "sk-ant-api03-rejectedrejectedrejected-XXXX";

/** Accepts every key except BAD; records what was tested. */
function fakeTester(): ProviderKeyTester & { tested: string[] } {
  const tested: string[] = [];
  return {
    tested,
    async test(apiKey) {
      tested.push(apiKey);
      const base = { at: new Date(), latencyMs: 1 };
      return (
        apiKey === BAD
          ? {
              ...base,
              ok: false,
              verdict: "invalid",
              httpStatus: 401,
              error: { code: "UNAUTHENTICATED", message: "rejected", retryable: false },
            }
          : { ...base, ok: true, verdict: "available", httpStatus: 200 }
      ) satisfies ProviderKeyTestResult;
    },
  };
}

function service(options: { secrets?: boolean } = {}) {
  const tester = fakeTester();
  const svc = createProviderConnectionService({
    connections: db.current.repos.providerConnections,
    audit: db.current.repos.audit,
    tester,
    secrets: options.secrets === false ? undefined : createSecretBox(randomBytes(32)),
  });
  return { svc, tester };
}

async function workspace(slug: string) {
  const ownerId = `usr_${slug.replace(/-/g, "")}`;
  await insertTestUser(db.current, { id: ownerId, email: `${slug}@example.test` });
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
    ownerUserId: ownerId,
  });
  const base = { organizationId: organization.id, workspaceId: workspace.id };
  const as = (actor: TenantContext["actor"]): TenantContext => ({ ...base, actor });
  return {
    admin: as({ type: "user", id: ownerId, role: "owner" }),
    alice: as({ type: "user", id: `${ownerId}_alice`, role: "editor" }),
    bob: as({ type: "user", id: `${ownerId}_bob`, role: "editor" }),
    viewer: as({ type: "user", id: `${ownerId}_viewer`, role: "viewer" }),
    worker: as({ type: "system", id: "worker" }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof StudixError ? e.code : String(e)),
  );
}

async function rowOf(id: string) {
  const rows = await db.current.db
    .select()
    .from(schema.providerConnections)
    .where(eq(schema.providerConnections.id, id));
  return rows[0]!;
}

describe("provider connections over Postgres", () => {
  it("stores only ciphertext and a hint, and audits without the key", async () => {
    const { svc } = service();
    const t = await workspace("pc-store");
    const view = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    expect(view).toMatchObject({ owner: "workspace", status: "available", keyHint: "sk-ant-…AAAA" });
    expect(JSON.stringify(view)).not.toContain(KEY_A);
    const row = await rowOf(view.id);
    expect(row.secretCiphertext).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(KEY_A);
    const audit = await db.current.repos.audit.list(t.admin, { subjectId: view.id });
    expect(audit.items.map((e) => e.action)).toContain("provider_connection.created");
    expect(JSON.stringify(audit.items)).not.toContain(KEY_A);
  });

  it("rejects a key Anthropic refuses and stores nothing", async () => {
    const { svc } = service();
    const t = await workspace("pc-bad");
    // Anthropic's refusal is bad input to Studix, not a Studix 401 that would read as "signed out".
    expect(await codeOf(svc.saveApiKey(t.admin, { owner: "workspace", apiKey: BAD }))).toBe("VALIDATION");
    expect(await codeOf(svc.saveApiKey(t.admin, { owner: "workspace", apiKey: "not-a-key" }))).toBe(
      "VALIDATION",
    );
    expect((await svc.overview(t.admin)).connections).toHaveLength(0);
  });

  it("enforces who may add which key and one active key per owner", async () => {
    const { svc, tester } = service();
    const t = await workspace("pc-perm");
    expect(await codeOf(svc.saveApiKey(t.alice, { owner: "workspace", apiKey: KEY_A }))).toBe("FORBIDDEN");
    expect(await codeOf(svc.saveApiKey(t.viewer, { owner: "user", apiKey: KEY_A }))).toBe("FORBIDDEN");
    expect(await codeOf(svc.saveApiKey(t.worker, { owner: "user", apiKey: KEY_A }))).toBe("FORBIDDEN");
    await svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_A });
    const calls = tester.tested.length;
    expect(await codeOf(svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_B }))).toBe("CONFLICT");
    // The duplicate is refused before any call to Anthropic.
    expect(tester.tested).toHaveLength(calls);
    await svc.saveApiKey(t.bob, { owner: "user", apiKey: KEY_B });
    const [alice, viewer] = [await svc.overview(t.alice), await svc.overview(t.viewer)];
    expect(alice.methods[0]).toMatchObject({ canAddWorkspaceKey: false, canAddPersonalKey: true });
    expect(viewer.methods[0]).toMatchObject({ canAddWorkspaceKey: false, canAddPersonalKey: false });
    expect((await svc.overview(t.admin)).methods[0]).toMatchObject({ canAddWorkspaceKey: true });
  });

  it("shows members workspace keys and their own personal key only; admins see all", async () => {
    const { svc } = service();
    const t = await workspace("pc-view");
    const ws = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    const alice = await svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_B });
    const bobView = await svc.overview(t.bob);
    expect(bobView.connections.map((c) => c.id)).toEqual([ws.id]);
    expect(bobView.connections[0]!.canManage).toBe(false);
    expect(await codeOf(svc.test(t.bob, alice.id))).toBe("NOT_FOUND");
    expect(await codeOf(svc.rotateApiKey(t.admin, alice.id, { apiKey: KEY_A }))).toBe("FORBIDDEN");
    const adminView = await svc.overview(t.admin);
    expect(adminView.connections.map((c) => c.id).sort()).toEqual([ws.id, alice.id].sort());
    expect(adminView.methods[1]).toMatchObject({
      authMethod: "oauth_subscription",
      availability: "restricted",
    });
  });

  it("rotates, tests and removes; removal erases the ciphertext", async () => {
    const { svc, tester } = service();
    const t = await workspace("pc-life");
    const view = await svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_A });
    const before = (await rowOf(view.id)).secretCiphertext;
    const rotated = await svc.rotateApiKey(t.alice, view.id, { apiKey: KEY_B });
    expect(rotated.keyHint).toBe("sk-ant-…BBBB");
    expect((await rowOf(view.id)).secretCiphertext).not.toBe(before);
    expect(await codeOf(svc.rotateApiKey(t.alice, view.id, { apiKey: BAD }))).toBe("VALIDATION");
    await svc.test(t.alice, view.id);
    expect(tester.tested.at(-1)).toBe(KEY_B);
    await svc.remove(t.alice, view.id);
    const row = await rowOf(view.id);
    expect(row).toMatchObject({ status: "revoked", secretCiphertext: null });
    expect(row.revokedAt).not.toBeNull();
    // The owner can add a new key once the old binding is gone.
    await svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_A });
  });

  it("releases keys for execution only to the right requester and never across tenants", async () => {
    const { svc } = service();
    const t = await workspace("pc-exec");
    const other = await workspace("pc-exec-other");
    const ws = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    const alice = await svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_B });
    const aliceRef = { type: "user" as const, id: t.alice.actor.id };
    const bobRef = { type: "user" as const, id: t.bob.actor.id };

    expect(
      (await svc.resolveForExecution(t.worker, { connectionId: ws.id, requestedBy: bobRef })).apiKey,
    ).toBe(KEY_A);
    expect(
      (await svc.resolveForExecution(t.worker, { connectionId: alice.id, requestedBy: aliceRef })).apiKey,
    ).toBe(KEY_B);
    expect(
      await codeOf(svc.resolveForExecution(t.worker, { connectionId: alice.id, requestedBy: bobRef })),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(svc.resolveForExecution(t.viewer, { connectionId: ws.id, requestedBy: bobRef })),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(svc.resolveForExecution(other.worker, { connectionId: ws.id, requestedBy: bobRef })),
    ).toBe("UNAVAILABLE");

    // A ciphertext copied into another tenant's row does not open there.
    const mine = await rowOf(ws.id);
    const theirs = await svc.saveApiKey(other.admin, { owner: "workspace", apiKey: KEY_B });
    await db.current.db
      .update(schema.providerConnections)
      .set({ secretCiphertext: mine.secretCiphertext })
      .where(eq(schema.providerConnections.id, theirs.id));
    expect(
      await codeOf(svc.resolveForExecution(other.worker, { connectionId: theirs.id, requestedBy: bobRef })),
    ).toBe("UNAVAILABLE");

    await svc.remove(t.admin, ws.id);
    expect(
      await codeOf(svc.resolveForExecution(t.worker, { connectionId: ws.id, requestedBy: bobRef })),
    ).toBe("UNAVAILABLE");
  });

  it("checks a planner selection for the caller without exposing the key", async () => {
    const { svc } = service();
    const t = await workspace("pc-usable");
    const other = await workspace("pc-usable-other");
    const ws = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    const alice = await svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_B });

    const view = await svc.assertUsable(t.bob, ws.id);
    expect(view.id).toBe(ws.id);
    expect(JSON.stringify(view)).not.toContain(KEY_A);
    expect((await svc.assertUsable(t.alice, alice.id)).id).toBe(alice.id);
    expect(await codeOf(svc.assertUsable(t.bob, alice.id))).toBe("FORBIDDEN");
    expect(await codeOf(svc.assertUsable(t.viewer, ws.id))).toBe("FORBIDDEN");
    expect(await codeOf(svc.assertUsable(other.admin, ws.id))).toBe("UNAVAILABLE");
  });

  it("refuses to execute with a key whose last test failed", async () => {
    const { svc } = service();
    const t = await workspace("pc-invalid");
    const view = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    await db.current.repos.providerConnections.update(t.admin, view.id, { status: "invalid" });
    expect(
      await codeOf(
        svc.resolveForExecution(t.worker, { connectionId: view.id, requestedBy: { type: "user", id: "x" } }),
      ),
    ).toBe("UNAUTHENTICATED");
  });

  it("marks only the rejected key invalid, so a key rotated meanwhile stays usable", async () => {
    const { svc } = service();
    const t = await workspace("pc-rejected");
    const view = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    const requestedBy = { type: "user", id: "x" } as const;
    const resolved = await svc.resolveForExecution(t.worker, { connectionId: view.id, requestedBy });
    const rejection: StudixErrorPayload = {
      code: "UNAUTHENTICATED",
      message: "Anthropic rejected the API key",
      retryable: false,
    };

    await svc.rotateApiKey(t.admin, view.id, { apiKey: KEY_B });
    await resolved.markRejected(rejection);
    expect((await svc.assertUsable(t.admin, view.id)).status).toBe("available");

    const current = await svc.resolveForExecution(t.worker, { connectionId: view.id, requestedBy });
    await current.markRejected(rejection);
    expect(await codeOf(svc.assertUsable(t.admin, view.id))).toBe("UNAUTHENTICATED");
    const overview = await svc.overview(t.admin);
    expect(overview.connections[0]).toMatchObject({
      status: "invalid",
      lastTest: { ok: false, httpStatus: 401, error: { code: "UNAUTHENTICATED" } },
    });
  });

  it("never lets a slow test of a replaced key overwrite the new key's status", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdOld = false;
    const tester: ProviderKeyTester = {
      async test(apiKey) {
        const base = { at: new Date(), latencyMs: 1 };
        if (holdOld && apiKey === KEY_A) {
          await held;
          return {
            ...base,
            ok: false,
            verdict: "invalid",
            httpStatus: 401,
            error: { code: "UNAUTHENTICATED", message: "rejected", retryable: false },
          };
        }
        return { ...base, ok: true, verdict: "available", httpStatus: 200 };
      },
    };
    const svc = createProviderConnectionService({
      connections: db.current.repos.providerConnections,
      audit: db.current.repos.audit,
      tester,
      secrets: createSecretBox(randomBytes(32)),
    });
    const t = await workspace("pc-race");
    const view = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    holdOld = true;
    const slowTest = svc.test(t.admin, view.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await svc.rotateApiKey(t.admin, view.id, { apiKey: KEY_B });
    release();
    const reported = await slowTest;
    expect(reported).toMatchObject({ status: "available", keyHint: "sk-ant-…BBBB" });
    expect((await rowOf(view.id)).status).toBe("available");
  });

  it("revokes a member's personal keys when the member is removed", async () => {
    const { svc } = service();
    const t = await workspace("pc-offboard");
    await insertTestUser(db.current, { id: t.alice.actor.id, email: "pc-offboard-alice@example.test" });
    await db.current.repos.workspaces.upsertMember(t.admin, { userId: t.alice.actor.id, role: "editor" });
    const ws = await svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A });
    const mine = await svc.saveApiKey(t.alice, { owner: "user", apiKey: KEY_B });
    expect(await db.current.repos.workspaces.removeMember(t.admin, t.alice.actor.id)).toBe(true);
    expect(await rowOf(mine.id)).toMatchObject({ status: "revoked", secretCiphertext: null });
    expect((await rowOf(ws.id)).status).toBe("available");
    const aliceRef = { type: "user" as const, id: t.alice.actor.id };
    expect(
      await codeOf(svc.resolveForExecution(t.worker, { connectionId: mine.id, requestedBy: aliceRef })),
    ).toBe("UNAVAILABLE");
  });

  it("reports the API-key method unavailable when no secrets key is configured", async () => {
    const { svc } = service({ secrets: false });
    const t = await workspace("pc-nokey");
    expect((await svc.overview(t.admin)).methods[0]).toMatchObject({ availability: "unavailable" });
    expect(await codeOf(svc.saveApiKey(t.admin, { owner: "workspace", apiKey: KEY_A }))).toBe("UNAVAILABLE");
  });
});
