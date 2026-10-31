import { randomBytes } from "node:crypto";
import { createCredentialVault, parseCredentialKeyring } from "@studix/auth";
import type { TenantContext } from "@studix/core";
import { StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConnectionProbe, createProviderAdmin } from "../src/provider-admin.ts";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

const KEY_A = "sk-or-v1-firstkey-0123456789abcdef0123456789";
const KEY_B = "sk-or-v1-secondkey-abcdef0123456789abcdef0123";

describe("AI provider API (Better Auth session, Postgres)", () => {
  let app: TestApp;
  let alice: string;
  let bob: string;
  const probed: string[] = [];
  let probeFailure: StudixError | undefined;
  const probe: ConnectionProbe = async (_ctx, binding) => {
    probed.push(binding.apiKey);
    if (probeFailure) throw probeFailure;
  };
  const keyring = parseCredentialKeyring(`k1:${randomBytes(32).toString("base64")}`);

  beforeAll(async () => {
    app = await startTestApp();
    const repos = app.db.repos;
    app.deps.providers = createProviderAdmin({
      connections: repos.providerConnections,
      preferences: repos.modelPreferences,
      vault: createCredentialVault({ store: repos.sealedCredentials, keyring }),
      probe,
    });
    alice = await app.signUp(`alice-ai-${Date.now()}@example.test`);
    bob = await app.signUp(`bob-ai-${Date.now()}@example.test`);
  });
  afterAll(async () => {
    await app?.close();
  });

  const json = async (res: Response) => ({ status: res.status, body: await res.json() });

  it("lists API-key providers with their models and OAuth marked restricted", async () => {
    const { status, body } = await json(await app.api("GET", "/api/providers/catalog", { cookie: alice }));
    expect(status).toBe(200);
    const ids = body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain("openrouter");
    expect(ids).not.toContain("amazon-bedrock");
    const anthropic = body.items.find((p: { id: string }) => p.id === "anthropic");
    expect(anthropic.authMethods).toEqual(["api_key"]);
    expect(anthropic.models.length).toBeGreaterThan(0);
  });

  it("stores a key sealed, returns only a hint, tests, rotates and deletes it", async () => {
    const created = await app.api("POST", "/api/providers/connections", {
      cookie: alice,
      body: { provider: "openrouter", label: "Team key", owner: "workspace", apiKey: KEY_A },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const text = await created.text();
    expect(text).not.toContain(KEY_A);
    const connection = JSON.parse(text);
    expect(connection).toMatchObject({ provider: "openrouter", status: "connected", keyHint: "sk-or…6789" });
    expect(connection.secretRef).toBeUndefined();
    const sealed = await app.db.client`select sealed from provider_credentials`;
    expect(JSON.stringify(sealed)).not.toContain(KEY_A);

    const listed = await json(await app.api("GET", "/api/providers/connections", { cookie: alice }));
    expect(JSON.stringify(listed.body)).not.toContain("secretRef");
    expect(listed.body.items).toHaveLength(1);

    const tested = await json(
      await app.api("POST", `/api/providers/connections/${connection.id}/test`, { cookie: alice, body: {} }),
    );
    expect(tested.body.lastTest).toMatchObject({ ok: true, code: "ok" });
    expect(probed.at(-1)).toBe(KEY_A);

    probeFailure = new StudixError("UNAUTHENTICATED", "openrouter rejected the credential: 401");
    const rejected = await json(
      await app.api("POST", `/api/providers/connections/${connection.id}/test`, { cookie: alice, body: {} }),
    );
    expect(rejected.body).toMatchObject({
      status: "invalid",
      lastTest: { ok: false, code: "unauthenticated" },
    });

    // A timeout says nothing about the key, so the connection stays invalid.
    probeFailure = new StudixError("TIMEOUT", "the provider did not answer in time");
    const timedOut = await json(
      await app.api("POST", `/api/providers/connections/${connection.id}/test`, { cookie: alice, body: {} }),
    );
    probeFailure = undefined;
    expect(timedOut.body).toMatchObject({ status: "invalid", lastTest: { ok: false, code: "timeout" } });

    const rotated = await app.api("POST", `/api/providers/connections/${connection.id}/rotate`, {
      cookie: alice,
      body: { apiKey: KEY_B },
    });
    const rotatedText = await rotated.text();
    expect(rotatedText).not.toContain(KEY_B);
    expect(JSON.parse(rotatedText)).toMatchObject({ status: "connected", keyHint: "sk-or…0123" });
    await app.api("POST", `/api/providers/connections/${connection.id}/test`, { cookie: alice, body: {} });
    expect(probed.at(-1)).toBe(KEY_B);

    const removed = await app.api("DELETE", `/api/providers/connections/${connection.id}`, { cookie: alice });
    expect(removed.status).toBe(204);
    expect(
      (await json(await app.api("GET", "/api/providers/connections", { cookie: alice }))).body.items,
    ).toEqual([]);
    expect(await app.db.client`select 1 from provider_credentials`).toHaveLength(0);
  });

  it("rejects custom endpoints, unsupported providers and malformed keys", async () => {
    const custom = await json(
      await app.api("POST", "/api/providers/connections", {
        cookie: alice,
        body: {
          provider: "openrouter",
          label: "x",
          owner: "workspace",
          apiKey: KEY_A,
          baseUrl: "http://169.254.169.254/",
        },
      }),
    );
    expect(custom).toMatchObject({ status: 400, body: { error: { code: "VALIDATION" } } });
    const bedrock = await json(
      await app.api("POST", "/api/providers/connections", {
        cookie: alice,
        body: { provider: "amazon-bedrock", label: "x", owner: "workspace", apiKey: KEY_A },
      }),
    );
    expect(bedrock).toMatchObject({ status: 400, body: { error: { code: "VALIDATION" } } });
    const spaced = await json(
      await app.api("POST", "/api/providers/connections", {
        cookie: alice,
        body: { provider: "openrouter", label: "x", owner: "workspace", apiKey: "sk with spaces inside" },
      }),
    );
    expect(spaced.status).toBe(400);
    expect(await app.db.client`select 1 from provider_credentials`).toHaveLength(0);
  });

  it("chooses models per stage, previews the effective one and keeps other workspaces out", async () => {
    const connection = (
      await json(
        await app.api("POST", "/api/providers/connections", {
          cookie: alice,
          body: { provider: "anthropic", label: "Claude", owner: "workspace", apiKey: KEY_A },
        }),
      )
    ).body;
    const catalog = (await json(await app.api("GET", "/api/providers/catalog", { cookie: alice }))).body;
    const [first, second] = catalog.items.find((p: { id: string }) => p.id === "anthropic").models;

    const put = (body: Record<string, unknown>, cookie = alice) =>
      app.api("PUT", "/api/providers/preferences", {
        cookie,
        body: { scope: "workspace", connectionId: connection.id, ...body },
      });
    expect((await put({ stage: "default", modelId: first.id })).status).toBe(200);
    expect((await put({ stage: "plan", modelId: second.id })).status).toBe(200);
    const unknownModel = await json(await put({ stage: "plan", modelId: "not-a-model" }));
    expect(unknownModel).toMatchObject({ status: 400, body: { error: { code: "VALIDATION" } } });

    const preview = (await json(await app.api("GET", "/api/providers/resolution", { cookie: alice }))).body;
    expect(preview.items).toEqual([
      {
        stage: "default",
        choice: {
          source: "workspace-default",
          connectionId: connection.id,
          provider: "anthropic",
          modelId: first.id,
        },
      },
      {
        stage: "plan",
        choice: {
          source: "workspace-stage",
          connectionId: connection.id,
          provider: "anthropic",
          modelId: second.id,
        },
      },
    ]);

    // Bob's workspace sees none of it and cannot reference Alice's connection.
    expect(
      (await json(await app.api("GET", "/api/providers/connections", { cookie: bob }))).body.items,
    ).toEqual([]);
    expect((await put({ stage: "plan", modelId: first.id }, bob)).status).toBe(404);
    const foreignTest = await app.api("POST", `/api/providers/connections/${connection.id}/test`, {
      cookie: bob,
      body: {},
    });
    expect(foreignTest.status).toBe(404);

    const prefs = (await json(await app.api("GET", "/api/providers/preferences", { cookie: alice }))).body
      .items;
    expect(prefs).toHaveLength(2);
    expect(
      (await app.api("DELETE", `/api/providers/preferences/${prefs[0].id}`, { cookie: alice })).status,
    ).toBe(204);
    expect(
      (await json(await app.api("GET", "/api/providers/preferences", { cookie: alice }))).body.items,
    ).toHaveLength(1);
  });

  it("lets editors connect personal keys but not change workspace-owned ones", async () => {
    const admin = app.deps.providers!;
    const owner = await app.provisionTenant("ai-roles");
    const editor: TenantContext = { ...owner, actor: { type: "user", id: "usr_editor", role: "editor" } };

    await expect(
      admin.createConnection(editor, {
        provider: "openai",
        label: "shared",
        owner: "workspace",
        apiKey: KEY_A,
        runtimes: ["pi"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const personal = await admin.createConnection(editor, {
      provider: "openai",
      label: "mine",
      owner: "personal",
      apiKey: KEY_A,
      runtimes: ["pi"],
    });
    expect(personal.owner).toEqual({ type: "user", userId: "usr_editor" });

    const shared = await admin.createConnection(owner, {
      provider: "openai",
      label: "shared",
      owner: "workspace",
      apiKey: KEY_B,
      runtimes: ["pi"],
    });
    await expect(admin.rotateConnection(editor, shared.id, { apiKey: KEY_A })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(admin.deleteConnection(editor, shared.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The owner cannot see, let alone touch, the editor's personal key.
    await expect(admin.deleteConnection(owner, personal.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers UNAVAILABLE when the server has no credential keyring", async () => {
    const providers = app.deps.providers;
    app.deps.providers = undefined;
    try {
      const res = await json(await app.api("GET", "/api/providers/connections", { cookie: alice }));
      expect(res).toMatchObject({ status: 503, body: { error: { code: "UNAVAILABLE" } } });
    } finally {
      app.deps.providers = providers;
    }
  });
});
