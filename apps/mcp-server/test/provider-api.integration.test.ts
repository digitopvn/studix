import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

/** A real model id from the pinned Pi catalog, so the server-side catalog check accepts it. */
async function catalogModel(app: TestApp, cookie: string, provider: string): Promise<string> {
  const res = await app.api("GET", "/api/providers/catalog", { cookie });
  const { providers } = (await res.json()) as {
    providers: Array<{ id: string; models: Array<{ id: string }> }>;
  };
  const model = providers.find((p) => p.id === provider)?.models[0]?.id;
  if (!model) throw new Error(`no ${provider} model in the catalog`);
  return model;
}

describe("provider and model API (Better Auth session, Postgres)", () => {
  let app: TestApp;
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    app = await startTestApp();
    alice = await app.signUp(`pa-alice-${Date.now()}@example.test`);
    bob = await app.signUp(`pa-bob-${Date.now()}@example.test`);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("lists the Pi catalog without OAuth and without ambient-auth providers", async () => {
    const res = await app.api("GET", "/api/providers/catalog", { cookie: alice });
    expect(res.status).toBe(200);
    const { providers } = (await res.json()) as { providers: Array<{ id: string; authMethods: string[] }> };
    expect(providers.map((p) => p.id)).toContain("openai");
    expect(providers.map((p) => p.id)).not.toContain("amazon-bedrock");
    expect(providers.every((p) => p.authMethods.join() === "api_key")).toBe(true);
    expect((await app.api("GET", "/api/providers/catalog")).status).toBe(401);
  });

  it("connects a non-Anthropic key, opts runtimes in and out, and never echoes the key", async () => {
    const apiKey = "sk-proj-test-key-not-real-0042";
    const created = await app.api("POST", "/api/providers/connections", {
      cookie: alice,
      body: { provider: "openai", owner: "workspace", apiKey, label: "OpenAI" },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const text = await created.text();
    expect(text).not.toContain(apiKey);
    const view = JSON.parse(text);
    expect(view).toMatchObject({ provider: "openai", runtimes: ["pi"], keyHint: "…0042", version: 1 });

    const claude = await app.api("PUT", `/api/providers/connections/${view.id}/runtimes`, {
      cookie: alice,
      body: { runtimes: ["claude"] },
    });
    expect(claude.status).toBe(400);

    const list = await (await app.api("GET", "/api/providers/connections", { cookie: alice })).json();
    expect(list.connections.map((c: { id: string }) => c.id)).toContain(view.id);
    // The Anthropic overview only lists Anthropic keys.
    const anthropic = await (await app.api("GET", "/api/providers/anthropic", { cookie: alice })).json();
    expect(anthropic.connections.map((c: { id: string }) => c.id)).not.toContain(view.id);

    // Another tenant cannot see or touch it.
    expect(
      (await app.api("POST", `/api/providers/connections/${view.id}/test`, { cookie: bob })).status,
    ).toBe(404);
    const tested = await app.api("POST", `/api/providers/connections/${view.id}/test`, { cookie: alice });
    expect((await tested.json()).lastTest).toMatchObject({ ok: true });
  });

  it("renames a connection with PATCH, enables Codex on an OpenAI key, and refuses ChatGPT without a client", async () => {
    const created = await app.api("POST", "/api/providers/connections", {
      cookie: alice,
      body: { provider: "openai", owner: "user", apiKey: "sk-proj-test-key-not-real-0077" },
    });
    expect(created.status).toBe(201);
    const view = await created.json();
    const renamed = await app.api("PATCH", `/api/providers/connections/${view.id}`, {
      cookie: alice,
      body: { label: "  Team OpenAI  " },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: view.id, label: "Team OpenAI", keyHint: "…0077" });
    for (const label of ["", " ", "x".repeat(81)]) {
      const bad = await app.api("PATCH", `/api/providers/connections/${view.id}`, {
        cookie: alice,
        body: { label },
      });
      expect(bad.status).toBe(400);
    }
    expect(
      (await app.api("PATCH", `/api/providers/connections/${view.id}`, { cookie: bob, body: { label: "x" } }))
        .status,
    ).toBe(404);

    const codex = await app.api("PUT", `/api/providers/connections/${view.id}/runtimes`, {
      cookie: alice,
      body: { runtimes: ["codex", "pi"] },
    });
    expect(codex.status).toBe(200);
    expect((await codex.json()).runtimes).toEqual(["codex", "pi"]);

    const start = await app.api("POST", "/api/providers/connections/chatgpt/start", {
      cookie: alice,
      body: { owner: "user" },
    });
    expect(start.status).toBe(503);
  });

  it("stores a workspace media key per vendor, isolated per workspace, and never echoes it", async () => {
    const apiKey = "sume-test-key-not-real-0099";
    const saved = await app.api("PUT", "/api/providers/media-keys/sume", { cookie: alice, body: { apiKey } });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const text = await saved.text();
    expect(text).not.toContain(apiKey);
    expect(JSON.parse(text)).toMatchObject({ vendor: "sume", source: "workspace", keyHint: "…0099" });

    const mine = await (await app.api("GET", "/api/providers/media-keys", { cookie: alice })).json();
    expect(mine.keys.find((k: { vendor: string }) => k.vendor === "sume")).toMatchObject({
      source: "workspace",
    });
    // Media keys are not AI provider connections.
    const list = await (await app.api("GET", "/api/providers/connections", { cookie: alice })).json();
    expect(list.connections.some((c: { provider: string }) => c.provider.startsWith("media-"))).toBe(false);

    const theirs = await (await app.api("GET", "/api/providers/media-keys", { cookie: bob })).json();
    expect(theirs.keys.find((k: { vendor: string }) => k.vendor === "sume")).toEqual({
      vendor: "sume",
      source: "platform",
    });
    expect((await app.api("DELETE", "/api/providers/media-keys/sume", { cookie: bob })).status).toBe(404);
    expect(
      (await app.api("PUT", "/api/providers/media-keys/openai", { cookie: alice, body: { apiKey } })).status,
    ).toBe(400);
    expect((await app.api("DELETE", "/api/providers/media-keys/sume", { cookie: alice })).status).toBe(200);
  });

  it("keeps the Anthropic route on Anthropic even if the body names another provider", async () => {
    const res = await app.api("POST", "/api/providers/anthropic/api-keys", {
      cookie: bob,
      body: { provider: "openai", owner: "workspace", apiKey: "sk-proj-test-key-not-real-0001" },
    });
    expect(res.status).toBe(400);
  });

  it("saves per-stage models, previews the effective one and deletes it", async () => {
    const key = await app.api("POST", "/api/providers/connections", {
      cookie: bob,
      body: { provider: "openrouter", owner: "workspace", apiKey: "sk-or-v1-test-key-not-real-0007" },
    });
    const connection = await key.json();
    const modelId = await catalogModel(app, bob, "openrouter");

    const empty = await (
      await app.api("GET", "/api/providers/models/preview?stage=plan", { cookie: bob })
    ).json();
    expect(empty.selection).toBeUndefined();

    const saved = await app.api("PUT", "/api/providers/models", {
      cookie: bob,
      body: { scope: "workspace", stage: "default", connectionId: connection.id, modelId },
    });
    expect(saved.status).toBe(200);
    const preference = await saved.json();
    expect(preference).toMatchObject({ provider: "openrouter", modelId, runtime: "pi", scope: "workspace" });

    const unknown = await app.api("PUT", "/api/providers/models", {
      cookie: bob,
      body: { scope: "workspace", stage: "plan", connectionId: connection.id, modelId: "not/a-model" },
    });
    expect(unknown.status).toBe(400);
    const badStage = await app.api("GET", "/api/providers/models/preview?stage=nope", { cookie: bob });
    expect(badStage.status).toBe(400);

    const preview = await (
      await app.api("GET", "/api/providers/models/preview?stage=plan", { cookie: bob })
    ).json();
    expect(preview.selection).toMatchObject({
      source: "workspace-default",
      usable: true,
      preference: { modelId },
    });

    // Alice's workspace is another tenant: nothing to see, nothing to delete.
    const aliceList = await (await app.api("GET", "/api/providers/models", { cookie: alice })).json();
    expect(aliceList.preferences).toEqual([]);
    expect(
      (await app.api("DELETE", `/api/providers/models/${preference.id}`, { cookie: alice })).status,
    ).toBe(404);

    expect((await app.api("DELETE", `/api/providers/models/${preference.id}`, { cookie: bob })).status).toBe(
      204,
    );
    const list = await (await app.api("GET", "/api/providers/models", { cookie: bob })).json();
    expect(list).toMatchObject({ stages: ["default", "plan"], runtimes: ["pi"], preferences: [] });
  });
});
