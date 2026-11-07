import { randomBytes } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  type ChatGptAuthClient,
  type ChatGptTokens,
  codexAuthJson,
  tokensFromCodexAuthJson,
} from "../src/chatgpt-auth.ts";
import { createProviderConnectionService } from "../src/provider-connection-service.ts";
import { createSecretBox } from "../src/secret-box.ts";

const db = withTestDatabase();

function idToken(email: string): string {
  const claims = Buffer.from(
    JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }),
  ).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${claims}.signature-signature`;
}

function tokens(refresh: string, email = "ana@example.test"): ChatGptTokens {
  return {
    idToken: idToken(email),
    accessToken: `access-token-${refresh}-xxxxxxxxxxxx`,
    refreshToken: refresh,
    accountId: "acct_1",
    lastRefresh: new Date().toISOString(),
  };
}

/** Pending on the first poll, authorized on the second; refresh rotates the refresh token. */
function fakeChatGpt(): ChatGptAuthClient & { polls: number; refreshed: string[] } {
  const client = {
    polls: 0,
    refreshed: [] as string[],
    async requestDeviceCode() {
      return { deviceAuthId: "dev_1", userCode: "ABCD-1234", intervalSeconds: 5 };
    },
    async poll() {
      client.polls += 1;
      return client.polls < 2
        ? { status: "pending" as const }
        : { status: "authorized" as const, tokens: tokens("refresh-1") };
    },
    async refresh(refreshToken: string) {
      client.refreshed.push(refreshToken);
      if (refreshToken === "revoked") {
        throw new StudixError("VALIDATION", "ChatGPT sign-in failed (token, HTTP 401)", { retryable: false });
      }
      return tokens(`${refreshToken}-next`);
    },
  };
  return client;
}

async function setup(slug: string) {
  const chatgpt = fakeChatGpt();
  const providers = createProviderConnectionService({
    connections: db.current.repos.providerConnections,
    audit: db.current.repos.audit,
    tester: {
      async test() {
        return { at: new Date(), latencyMs: 1, ok: true, verdict: "available" };
      },
    },
    isSupportedProvider: () => true,
    secrets: createSecretBox(randomBytes(32)),
    chatgpt,
  });
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
    providers,
    chatgpt,
    alice: as({ type: "user", id: `${ownerId}_alice`, role: "editor" }),
    bob: as({ type: "user", id: `${ownerId}_bob`, role: "editor" }),
    admin: as({ type: "user", id: ownerId, role: "owner" }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof StudixError ? e.code : String(e)),
  );
}

describe("ChatGPT sign-in for the codex runtime", () => {
  it("connects through the device code, never shows the tokens, and runs only on codex", async () => {
    const t = await setup("cg-login");
    const start = await t.providers.startChatGptLogin(t.alice, {});
    expect(start).toMatchObject({ userCode: "ABCD-1234", intervalSeconds: 5 });
    expect(start.flowToken).not.toContain("dev_1");

    // Only the user who started the sign-in may finish it.
    expect(await codeOf(t.providers.pollChatGptLogin(t.bob, { flowToken: start.flowToken }))).toBe(
      "FORBIDDEN",
    );
    expect(await t.providers.pollChatGptLogin(t.alice, { flowToken: start.flowToken })).toEqual({
      status: "pending",
      intervalSeconds: 5,
    });
    const done = await t.providers.pollChatGptLogin(t.alice, { flowToken: start.flowToken });
    if (done.status !== "connected") throw new Error("expected a connection");
    const view = done.connection;
    expect(view).toMatchObject({
      provider: "openai",
      authMethod: "oauth_subscription",
      billing: "subscription",
      runtimes: ["codex"],
      owner: "user",
      label: "ChatGPT (ana@example.test)",
      status: "available",
    });
    expect(JSON.stringify(view)).not.toContain("refresh-1");

    await t.providers.assertUsable(t.alice, view.id, "codex");
    expect(await codeOf(t.providers.assertUsable(t.alice, view.id, "pi"))).toBe("FORBIDDEN");
    expect(await codeOf(t.providers.setRuntimes(t.alice, view.id, { runtimes: ["pi"] }))).toBe("VALIDATION");

    const credential = await t.providers.resolveForExecution(t.alice, {
      connectionId: view.id,
      requestedBy: { type: "user", id: t.alice.actor.id },
      runtime: "codex",
    });
    expect(tokensFromCodexAuthJson(credential.apiKey)?.refreshToken).toBe("refresh-1");

    // The CLI rotated the refresh token during the run: the next run gets the new one.
    await credential.storeRefreshed(codexAuthJson(tokens("refresh-2")));
    const next = await t.providers.resolveForExecution(t.alice, {
      connectionId: view.id,
      requestedBy: { type: "user", id: t.alice.actor.id },
      runtime: "codex",
    });
    expect(tokensFromCodexAuthJson(next.apiKey)?.refreshToken).toBe("refresh-2");

    // Test refreshes the login and stores the rotated token.
    const tested = await t.providers.test(t.alice, view.id);
    expect(tested.lastTest).toMatchObject({ ok: true });
    expect(t.chatgpt.refreshed).toEqual(["refresh-2"]);
  });

  it("refuses an expired, foreign or workspace sign-in the caller may not finish", async () => {
    const t = await setup("cg-refuse");
    expect(await codeOf(t.providers.startChatGptLogin(t.alice, { owner: "workspace" }))).toBe("FORBIDDEN");
    const other = await setup("cg-refuse-other");
    const start = await other.providers.startChatGptLogin(other.alice, {});
    expect(await codeOf(t.providers.pollChatGptLogin(t.alice, { flowToken: start.flowToken }))).toBe(
      "VALIDATION",
    );
  });
});

describe("renaming a provider connection", () => {
  it("trims the label, audits old and new, and keeps the secret and version", async () => {
    const t = await setup("cg-rename");
    const created = await t.providers.saveApiKey(t.alice, {
      provider: "openai",
      owner: "user",
      apiKey: "sk-proj-renamerenamerename-0003",
    });
    const renamed = await t.providers.setLabel(t.alice, created.id, { label: "  My OpenAI  " });
    expect(renamed).toMatchObject({ label: "My OpenAI", keyHint: created.keyHint, version: created.version });
    expect(await codeOf(t.providers.setLabel(t.alice, created.id, { label: " " }))).toBe("VALIDATION");
    expect(await codeOf(t.providers.setLabel(t.alice, created.id, { label: "x".repeat(81) }))).toBe(
      "VALIDATION",
    );
    // Someone else's personal key is invisible to them.
    expect(await codeOf(t.providers.setLabel(t.bob, created.id, { label: "Mine" }))).toBe("NOT_FOUND");
    const events = await db.current.repos.audit.list(t.admin, { subjectId: created.id });
    const event = events.items.find((e) => e.action === "provider_connection.renamed");
    expect(event?.data).toMatchObject({ from: "Personal key", to: "My OpenAI" });
  });
});
