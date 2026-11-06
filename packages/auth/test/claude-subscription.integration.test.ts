import { randomBytes } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import type { ProviderKeyTester } from "../src/anthropic-key-tester.ts";
import { createProviderConnectionService } from "../src/provider-connection-service.ts";
import { createSecretBox } from "../src/secret-box.ts";

const db = withTestDatabase();
const TOKEN = "sk-ant-oat01-subscriptiontokenforthetest-ZZZZ";

function service(options: { enabled?: boolean; secrets?: boolean } = {}) {
  const tested: string[] = [];
  const tester: ProviderKeyTester = {
    async test(apiKey) {
      tested.push(apiKey);
      return { ok: true, verdict: "available", at: new Date(), latencyMs: 1, httpStatus: 200 };
    },
  };
  const svc = createProviderConnectionService({
    connections: db.current.repos.providerConnections,
    audit: db.current.repos.audit,
    tester,
    secrets: options.secrets === false ? undefined : createSecretBox(randomBytes(32)),
    claudeSubscription: options.enabled ?? true,
  });
  return { svc, tested };
}

async function workspace(slug: string) {
  const ownerId = `usr_${slug.replace(/-/g, "")}`;
  await insertTestUser(db.current, { id: ownerId, email: `${slug}@example.test` });
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
    ownerUserId: ownerId,
  });
  const as = (actor: TenantContext["actor"]): TenantContext => ({
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor,
  });
  return {
    admin: as({ type: "user", id: ownerId, role: "owner" }),
    alice: as({ type: "user", id: `${ownerId}_alice`, role: "editor" }),
    bob: as({ type: "user", id: `${ownerId}_bob`, role: "editor" }),
    worker: as({ type: "system", id: "worker" }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof StudixError ? e.code : String(e)),
  );
}

describe("Claude subscription connections (self-hosted)", () => {
  it("stays restricted and refuses to connect when the operator flag is off", async () => {
    const { svc } = service({ enabled: false });
    const t = await workspace("sub-off");
    const overview = await svc.overview(t.alice);
    expect(overview.methods[1]).toMatchObject({ availability: "restricted", canConnect: false });
    expect(await codeOf(svc.connectSubscription(t.alice, { token: TOKEN }))).toBe("FORBIDDEN");
  });

  it("refuses to store a token without encrypted credential storage", async () => {
    const { svc } = service({ secrets: false });
    const t = await workspace("sub-nostore");
    const overview = await svc.overview(t.alice);
    expect(overview.methods[1]).toMatchObject({ availability: "unavailable" });
    expect(overview.methods[1].reason).toContain("STUDIX_SECRETS_KEY");
    expect(await codeOf(svc.connectSubscription(t.alice, { token: TOKEN }))).toBe("UNAVAILABLE");
  });

  it("stores the token per user, never tests it against the API, and releases it only to its owner's Claude jobs", async () => {
    const { svc, tested } = service();
    const t = await workspace("sub-on");
    expect((await svc.overview(t.alice)).methods[1]).toMatchObject({
      availability: "available",
      canConnect: true,
    });
    const view = await svc.connectSubscription(t.alice, { token: TOKEN });
    expect(view).toMatchObject({
      authMethod: "oauth_subscription",
      owner: "user",
      billing: "subscription",
      runtimes: ["claude"],
      status: "unverified",
    });
    expect(view.keyHint).not.toContain(TOKEN);
    expect(await svc.test(t.alice, view.id)).toMatchObject({ status: "unverified" });
    expect(tested).toEqual([]);

    const mine = await svc.resolveForExecution(t.worker, {
      connectionId: view.id,
      requestedBy: { type: "user", id: t.alice.actor.id },
      runtime: "claude",
    });
    expect(mine).toMatchObject({ apiKey: TOKEN, authMethod: "oauth_subscription" });
    expect(
      await codeOf(
        svc.resolveForExecution(t.worker, {
          connectionId: view.id,
          requestedBy: { type: "user", id: t.bob.actor.id },
          runtime: "claude",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        svc.resolveForExecution(t.worker, {
          connectionId: view.id,
          requestedBy: { type: "user", id: t.alice.actor.id },
          runtime: "pi",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await codeOf(svc.setRuntimes(t.alice, view.id, { runtimes: ["claude", "pi"] }))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(svc.connectSubscription(t.alice, { token: TOKEN }))).toBe("CONFLICT");
    // Bob cannot see or use Alice's subscription.
    expect((await svc.overview(t.bob)).connections.some((c) => c.id === view.id)).toBe(false);

    await mine.markRejected();
    expect(tested).toEqual([]);
    expect(
      await codeOf(
        svc.resolveForExecution(t.worker, {
          connectionId: view.id,
          requestedBy: { type: "user", id: t.alice.actor.id },
          runtime: "claude",
        }),
      ),
    ).toBe("UNAUTHENTICATED");
    await svc.remove(t.alice, view.id);
  });

  it("never accepts a subscription token as an API key, and turns it off with the flag", async () => {
    const { svc, tested } = service();
    const t = await workspace("sub-asapikey");
    expect(await codeOf(svc.saveApiKey(t.alice, { owner: "user", apiKey: TOKEN }))).toBe("VALIDATION");
    expect(tested).toEqual([]);
    const view = await svc.connectSubscription(t.alice, { token: TOKEN });
    const off = service({ enabled: false }).svc;
    expect((await off.overview(t.alice)).connections.some((c) => c.id === view.id)).toBe(false);
    expect(
      await codeOf(
        off.resolveForExecution(t.worker, {
          connectionId: view.id,
          requestedBy: { type: "user", id: t.alice.actor.id },
          runtime: "claude",
        }),
      ),
    ).toBe("UNAVAILABLE");
  });
});
