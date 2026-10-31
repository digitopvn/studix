import { randomBytes } from "node:crypto";
import type { ResolvedModelSnapshot, TenantContext } from "@studix/core";
import { schema } from "@studix/database";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ProviderKeyTester } from "../src/anthropic-key-tester.ts";
import { createModelPreferenceService } from "../src/model-preference-service.ts";
import { createProviderConnectionService } from "../src/provider-connection-service.ts";
import { createSecretBox } from "../src/secret-box.ts";

const db = withTestDatabase();
const ANTHROPIC_KEY = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa-AAAA";
const OPENAI_KEY = "sk-proj-openaiopenaiopenai-0001";
const OPENROUTER_KEY = "sk-or-v1-openrouteropenrouter-0002";

/** Accepts every key; records which provider each test was routed to. */
function fakeTester(): ProviderKeyTester & { providers: string[] } {
  const providers: string[] = [];
  return {
    providers,
    async test(_apiKey, provider) {
      providers.push(provider);
      return { at: new Date(), latencyMs: 1, ok: true, verdict: "available" };
    },
  };
}

/** Models the fake catalog knows: one per provider. */
const KNOWN: Record<string, string> = {
  openai: "gpt-test",
  openrouter: "router/test",
  anthropic: "claude-test",
};

function services() {
  const tester = fakeTester();
  const providers = createProviderConnectionService({
    connections: db.current.repos.providerConnections,
    audit: db.current.repos.audit,
    tester,
    isSupportedProvider: (p) => p in KNOWN,
    secrets: createSecretBox(randomBytes(32)),
  });
  const models = createModelPreferenceService({
    preferences: db.current.repos.modelPreferences,
    providers,
    audit: db.current.repos.audit,
    knownModel: (provider, modelId) => KNOWN[provider] === modelId,
  });
  return { providers, models, tester };
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

describe("provider connections for several runtimes", () => {
  it("stores keys of several providers side by side with runtime defaults by provider", async () => {
    const { providers, tester } = services();
    const t = await workspace("pr-multi");
    const anthropic = await providers.saveApiKey(t.admin, { owner: "workspace", apiKey: ANTHROPIC_KEY });
    const openai = await providers.saveApiKey(t.admin, {
      provider: "openai",
      owner: "workspace",
      apiKey: OPENAI_KEY,
    });
    expect(anthropic).toMatchObject({
      provider: "anthropic",
      runtimes: ["claude"],
      billing: "usage_based",
      version: 1,
    });
    expect(openai).toMatchObject({ provider: "openai", runtimes: ["pi"], keyHint: "…0001" });
    expect(tester.providers).toEqual(["anthropic", "openai"]);
    // One active key per owner and provider, not per owner.
    expect(
      await codeOf(
        providers.saveApiKey(t.admin, { provider: "openai", owner: "workspace", apiKey: OPENAI_KEY }),
      ),
    ).toBe("CONFLICT");
    const list = await providers.list(t.bob);
    expect(list.connections.map((c) => c.provider).sort()).toEqual(["anthropic", "openai"]);
    // The Anthropic-only overview keeps its old shape.
    expect((await providers.overview(t.bob)).connections.map((c) => c.provider)).toEqual(["anthropic"]);
  });

  it("validates provider, key shape and runtime choice at the boundary", async () => {
    const { providers } = services();
    const t = await workspace("pr-validate");
    expect(
      await codeOf(
        providers.saveApiKey(t.admin, { provider: "amazon-bedrock", owner: "workspace", apiKey: OPENAI_KEY }),
      ),
    ).toBe("VALIDATION");
    expect(
      await codeOf(
        providers.saveApiKey(t.admin, { provider: "anthropic", owner: "workspace", apiKey: OPENAI_KEY }),
      ),
    ).toBe("VALIDATION");
    expect(
      await codeOf(
        providers.saveApiKey(t.admin, { provider: "openai", owner: "workspace", apiKey: "has space x" }),
      ),
    ).toBe("VALIDATION");
    expect(
      await codeOf(
        providers.saveApiKey(t.admin, {
          provider: "openai",
          owner: "workspace",
          apiKey: OPENAI_KEY,
          runtimes: ["claude"],
        }),
      ),
    ).toBe("VALIDATION");
    const openai = await providers.saveApiKey(t.admin, {
      provider: "openai",
      owner: "workspace",
      apiKey: OPENAI_KEY,
    });
    // A rotated key must keep the provider's shape too.
    expect(await codeOf(providers.rotateApiKey(t.admin, openai.id, { apiKey: "a b" }))).toBe("VALIDATION");
  });

  it("releases an existing Anthropic key to Pi only after an opt-in, and bumps the version", async () => {
    const { providers } = services();
    const t = await workspace("pr-optin");
    const key = await providers.saveApiKey(t.admin, { owner: "workspace", apiKey: ANTHROPIC_KEY });
    const requestedBy = { type: "user" as const, id: t.bob.actor.id };
    expect(
      await codeOf(
        providers.resolveForExecution(t.worker, { connectionId: key.id, requestedBy, runtime: "pi" }),
      ),
    ).toBe("FORBIDDEN");
    expect(await codeOf(providers.assertUsable(t.bob, key.id, "pi"))).toBe("FORBIDDEN");

    // Only the people who manage the key may opt it in.
    expect(await codeOf(providers.setRuntimes(t.bob, key.id, { runtimes: ["claude", "pi"] }))).toBe(
      "FORBIDDEN",
    );
    const opted = await providers.setRuntimes(t.admin, key.id, { runtimes: ["pi", "claude"] });
    expect(opted).toMatchObject({ runtimes: ["claude", "pi"], version: 2 });
    const resolved = await providers.resolveForExecution(t.worker, {
      connectionId: key.id,
      requestedBy,
      runtime: "pi",
    });
    expect(resolved.apiKey).toBe(ANTHROPIC_KEY);
    expect(resolved.connection.version).toBe(2);

    // Opting out of claude stops the Claude planner from using it.
    await providers.setRuntimes(t.admin, key.id, { runtimes: ["pi"] });
    expect(await codeOf(providers.assertUsable(t.bob, key.id, "claude"))).toBe("FORBIDDEN");
    const rotated = await providers.rotateApiKey(t.admin, key.id, {
      apiKey: ANTHROPIC_KEY.replace("AAAA", "CCCC"),
    });
    expect(rotated.version).toBe(4);
  });

  it("never lets the claude runtime use a non-Anthropic key", async () => {
    const { providers } = services();
    const t = await workspace("pr-claude-only");
    const openai = await providers.saveApiKey(t.admin, {
      provider: "openai",
      owner: "workspace",
      apiKey: OPENAI_KEY,
    });
    expect(await codeOf(providers.setRuntimes(t.admin, openai.id, { runtimes: ["claude", "pi"] }))).toBe(
      "VALIDATION",
    );
    // Even a row edited behind the service's back is refused for claude.
    await db.current.db
      .update(schema.providerConnections)
      .set({ runtimes: ["claude", "pi"] })
      .where(eq(schema.providerConnections.id, openai.id));
    expect(await codeOf(providers.assertUsable(t.admin, openai.id, "claude"))).toBe("FORBIDDEN");
  });

  it("migrated rows default to the claude runtime, usage billing and version 1", async () => {
    const t = await workspace("pr-defaults");
    await db.current.db.execute(sql`
      insert into provider_connections
        (id, organization_id, workspace_id, provider, auth_method, owner_type, owner_key, label, status,
         secret_ciphertext, secret_hint, created_by_type, created_by_id, created_at, updated_at)
      values ('pcon_legacy', ${t.admin.organizationId}, ${t.admin.workspaceId}, 'anthropic', 'api_key',
        'workspace', 'workspace', 'old', 'available', 'v1.x.y', 'sk-ant-…old', 'user', ${t.admin.actor.id},
        now(), now())`);
    const row = await db.current.repos.providerConnections.get(t.admin, "pcon_legacy");
    expect(row).toMatchObject({ runtimes: ["claude"], billingSource: "usage_based", version: 1 });
  });
});

describe("model preferences", () => {
  async function seeded(slug: string) {
    const { providers, models } = services();
    const t = await workspace(slug);
    const shared = await providers.saveApiKey(t.admin, {
      provider: "openai",
      owner: "workspace",
      apiKey: OPENAI_KEY,
    });
    const personal = await providers.saveApiKey(t.alice, {
      provider: "openrouter",
      owner: "user",
      apiKey: OPENROUTER_KEY,
    });
    return { providers, models, t, shared, personal };
  }

  it("lets admins set workspace defaults and members their own, with dev's permissions", async () => {
    const { models, t, shared, personal } = await seeded("mp-perms");
    expect(
      await codeOf(
        models.save(t.bob, {
          scope: "workspace",
          stage: "default",
          connectionId: shared.id,
          modelId: "gpt-test",
        }),
      ),
    ).toBe("FORBIDDEN");
    const ws = await models.save(t.admin, {
      scope: "workspace",
      stage: "default",
      connectionId: shared.id,
      modelId: "gpt-test",
    });
    expect(ws).toMatchObject({ scope: "workspace", provider: "openai", runtime: "pi", canManage: true });
    // A workspace entry never points at someone's personal key.
    expect(
      await codeOf(
        models.save(t.admin, {
          scope: "workspace",
          stage: "plan",
          connectionId: personal.id,
          modelId: "router/test",
        }),
      ),
    ).toBe("FORBIDDEN");
    const mine = await models.save(t.alice, {
      scope: "user",
      stage: "plan",
      connectionId: personal.id,
      modelId: "router/test",
    });
    // Bob cannot use Alice's key, and the viewer cannot write at all.
    expect(
      await codeOf(
        models.save(t.bob, {
          scope: "user",
          stage: "plan",
          connectionId: personal.id,
          modelId: "router/test",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        models.save(t.viewer, { scope: "user", stage: "plan", connectionId: shared.id, modelId: "gpt-test" }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        models.save(t.admin, { scope: "workspace", stage: "plan", connectionId: shared.id, modelId: "nope" }),
      ),
    ).toBe("VALIDATION");

    const bobView = await models.list(t.bob);
    expect(bobView.preferences.map((p) => p.id)).toEqual([ws.id]);
    expect(bobView.preferences[0]!.canManage).toBe(false);
    expect(await codeOf(models.remove(t.bob, mine.id))).toBe("NOT_FOUND");
    expect(await codeOf(models.remove(t.bob, ws.id))).toBe("FORBIDDEN");
    await models.remove(t.alice, mine.id);
    expect((await models.list(t.alice)).preferences.map((p) => p.id)).toEqual([ws.id]);
  });

  it("refuses a key that is not enabled for Pi until it is opted in", async () => {
    const { providers, models, t } = await seeded("mp-optin");
    const anthropic = await providers.saveApiKey(t.admin, { owner: "workspace", apiKey: ANTHROPIC_KEY });
    const input = {
      scope: "workspace",
      stage: "default",
      connectionId: anthropic.id,
      modelId: "claude-test",
    } as const;
    expect(await codeOf(models.save(t.admin, input))).toBe("FORBIDDEN");
    await providers.setRuntimes(t.admin, anthropic.id, { runtimes: ["claude", "pi"] });
    expect((await models.save(t.admin, input)).provider).toBe("anthropic");
  });

  it("previews the effective model per caller and stage, and flags an unusable choice", async () => {
    const { models, t, shared, personal } = await seeded("mp-preview");
    expect((await models.preview(t.bob, { stage: "plan" })).selection).toBeUndefined();
    await models.save(t.admin, {
      scope: "workspace",
      stage: "default",
      connectionId: shared.id,
      modelId: "gpt-test",
    });
    await models.save(t.alice, {
      scope: "user",
      stage: "plan",
      connectionId: personal.id,
      modelId: "router/test",
    });

    expect((await models.preview(t.bob, { stage: "plan" })).selection).toMatchObject({
      source: "workspace-default",
      usable: true,
      preference: { modelId: "gpt-test" },
    });
    expect((await models.preview(t.alice, { stage: "plan" })).selection).toMatchObject({
      source: "user-stage",
      preference: { modelId: "router/test" },
    });
    expect((await models.preview(t.viewer, { stage: "plan" })).selection).toMatchObject({ usable: false });
    expect(await codeOf(models.preview(t.bob, { stage: "nonsense" as "plan" }))).toBe("VALIDATION");

    // Pi disabled on the key: the preference stays but the preview says it cannot run.
    await db.current.db
      .update(schema.providerConnections)
      .set({ runtimes: [] })
      .where(eq(schema.providerConnections.id, shared.id));
    expect((await models.preview(t.bob, { stage: "plan" })).selection).toMatchObject({ usable: false });
  });

  it("deletes the preferences of a revoked key so resolution falls through", async () => {
    const { providers, models, t, shared } = await seeded("mp-revoke");
    const second = await providers.saveApiKey(t.alice, {
      provider: "openai",
      owner: "user",
      apiKey: OPENAI_KEY,
    });
    await models.save(t.admin, {
      scope: "workspace",
      stage: "default",
      connectionId: shared.id,
      modelId: "gpt-test",
    });
    await models.save(t.alice, {
      scope: "user",
      stage: "default",
      connectionId: second.id,
      modelId: "gpt-test",
    });
    await providers.remove(t.alice, second.id);
    expect((await models.preview(t.alice, { stage: "plan" })).selection).toMatchObject({
      source: "workspace-default",
    });
    expect((await models.list(t.alice)).preferences).toHaveLength(1);
  });
});

describe("job model snapshots", () => {
  it("pins once per job, runtime and stage; the first writer wins and other tenants see nothing", async () => {
    const t = await workspace("snap-pin");
    const other = await workspace("snap-other");
    const { job } = await db.current.repos.queue.enqueue(t.admin, {
      kind: "video.create",
      payload: { brief: "x" },
      budgetCents: 100,
      createdBy: { type: "user", id: t.admin.actor.id },
    });
    const snapshot = (modelId: string): ResolvedModelSnapshot => ({
      runtime: "pi",
      stage: "plan",
      source: "workspace-default",
      connectionId: "pcon_x",
      connectionVersion: 1,
      provider: "openai",
      modelId,
      billingSource: "usage_based",
      allowFallback: false,
      fallbacks: [],
    });
    const snapshots = db.current.repos.modelSnapshots;
    const [a, b] = await Promise.all([
      snapshots.pin(t.worker, job.id, snapshot("first")),
      snapshots.pin(t.worker, job.id, snapshot("second")),
    ]);
    expect(a.modelId).toBe(b.modelId);
    expect((await snapshots.get(t.worker, job.id, { runtime: "pi", stage: "plan" }))?.modelId).toBe(
      a.modelId,
    );
    expect(await snapshots.get(other.worker, job.id, { runtime: "pi", stage: "plan" })).toBeUndefined();
    expect(await codeOf(snapshots.pin(other.worker, job.id, snapshot("x")))).toBe("NOT_FOUND");
  });
});
