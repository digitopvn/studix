import { randomBytes } from "node:crypto";
import { createPlatformCredentialService, createSecretBox } from "@studix/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

const VENDOR_KEY = "vendor-route-key-abcdefgh-4242";
const ACCESS = "AKIAROUTEACCESS5678";
const SECRET = "route-secret-must-never-leak-1357";

describe("platform credential API (Better Auth session, Postgres)", () => {
  let app: TestApp;
  let operator: string;
  let member: string;
  const probed: string[] = [];

  beforeAll(async () => {
    app = await startTestApp();
    operator = await app.signUp(`pl-operator-${Date.now()}@example.test`);
    member = await app.signUp(`pl-member-${Date.now()}@example.test`);
    // The operator role is never granted through the product: it is set directly in the database.
    const operatorId = await userIdOf(operator);
    await app.db.client`update members set role = 'operator' where user_id = ${operatorId}`;
    const [row] = await app.db.client<
      { workspace_id: string }[]
    >`select workspace_id from members where user_id = ${operatorId}`;
    const platformWorkspace = row?.workspace_id as string;
    const platformCredentials = createPlatformCredentialService({
      secrets: app.db.repos.platformSecrets,
      box: createSecretBox(randomBytes(32)),
      audit: app.db.repos.audit,
      directory: app.db.repos.directory,
      platformWorkspaceId: platformWorkspace,
      env: {},
      storage: {
        describe: () => ({ bucket: "b", region: "auto", forcePathStyle: true, signedUrlTtlSeconds: 60 }),
        async probe(candidate) {
          probed.push(candidate?.accessKeyId ?? "active");
          return { ok: true, latencyMs: 2 };
        },
      },
      vendorTester: async () => ({ verdict: "available", httpStatus: 200 }),
    });
    Object.assign(app.deps, { platformCredentials });
  });
  afterAll(async () => {
    await app?.close();
  });

  async function userIdOf(cookie: string): Promise<string> {
    const me = (await (await app.api("GET", "/api/me", { cookie })).json()) as {
      user?: { id: string };
      id?: string;
    };
    return (me.user?.id ?? me.id) as string;
  }

  it("refuses every route to a workspace owner and to unauthenticated callers", async () => {
    for (const [method, path] of [
      ["GET", "/api/platform/credentials"],
      ["PUT", "/api/platform/credentials/media/SUME_API_KEY"],
      ["POST", "/api/platform/credentials/storage/test"],
      ["POST", "/api/platform/media/check"],
      ["DELETE", "/api/platform/credentials/SUME_API_KEY"],
    ] as const) {
      const res = await app.api(method, path, {
        cookie: member,
        ...(method === "GET" ? {} : { body: { apiKey: VENDOR_KEY } }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(
        (await app.api(method, path, method === "GET" ? {} : { body: { apiKey: VENDOR_KEY } })).status,
      ).toBe(401);
    }
  });

  it("lets an operator store, rotate and revoke a key without ever echoing it", async () => {
    const put = await app.api("PUT", "/api/platform/credentials/media/SUME_API_KEY", {
      cookie: operator,
      body: { apiKey: VENDOR_KEY },
    });
    expect(put.status).toBe(200);
    expect(put.headers.get("cache-control")).toBe("no-store");
    const text = await put.text();
    expect(text).not.toContain(VENDOR_KEY);
    expect(
      JSON.parse(text).media.vendors.find((v: { name: string }) => v.name === "SUME_API_KEY"),
    ).toMatchObject({
      source: "dashboard",
      hint: "…4242",
    });

    const stored = await app.api("PUT", "/api/platform/credentials/storage", {
      cookie: operator,
      body: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    });
    expect(stored.status).toBe(200);
    expect(await stored.text()).not.toContain(SECRET);
    expect(probed).toContain(ACCESS);

    const rejected = await app.api("PUT", "/api/platform/credentials/media/PATH", {
      cookie: operator,
      body: { apiKey: VENDOR_KEY },
    });
    expect(rejected.status).toBe(404);

    const revoked = await app.api("DELETE", "/api/platform/credentials/SUME_API_KEY", { cookie: operator });
    expect(revoked.status).toBe(200);
    const after = await (await app.api("GET", "/api/platform/credentials", { cookie: operator })).text();
    expect(after).not.toContain(VENDOR_KEY);
    expect(after).not.toContain(SECRET);
  });
});
