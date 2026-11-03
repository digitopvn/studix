import { createHash, randomBytes } from "node:crypto";
import { createMcpOAuth, McpTokenError } from "@studix/auth";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

const REDIRECT = "http://127.0.0.1:9/callback";

const b64url = (buf: Buffer) => buf.toString("base64url");

describe("MCP OAuth 2.1", () => {
  let t: TestApp;
  let resource: string;
  beforeAll(async () => {
    t = await startTestApp({ rateLimits: { auth: { capacity: 500, refillPerSecond: 100 } } });
    resource = `${t.base}/mcp`;
  });
  afterAll(async () => {
    await t.close();
  });

  async function registerClient(redirect = REDIRECT) {
    const res = await fetch(`${t.base}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Agent",
        application_type: "native",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "studix:read studix:write offline_access",
      }),
    });
    const text = await res.text();
    expect({ status: res.status, text: res.status === 201 ? "" : text }).toEqual({ status: 201, text: "" });
    return JSON.parse(text) as { client_id: string };
  }

  function pkce() {
    const verifier = b64url(randomBytes(32));
    return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
  }

  /** Where an authorize response sends the browser: a Location header, or the JSON form for fetch callers. */
  async function redirectOf(res: Response): Promise<string> {
    const header = res.headers.get("location");
    if (header) return header;
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { url?: string };
    return body.url ?? "";
  }

  /** Runs authorize + consent and returns the callback URL the browser would be sent to. */
  async function authorize(
    cookie: string,
    clientId: string,
    options: {
      scope?: string;
      resource?: string | null;
      challenge: string;
      state?: string;
      redirect?: string;
    },
  ) {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: options.redirect ?? REDIRECT,
      scope: options.scope ?? "studix:read studix:write offline_access",
      state: options.state ?? "state-1",
      code_challenge: options.challenge,
      code_challenge_method: "S256",
    });
    if (options.resource !== null) params.set("resource", options.resource ?? resource);
    const res = await fetch(`${t.base}/api/auth/oauth2/authorize?${params}`, {
      headers: { cookie },
      redirect: "manual",
    });
    return res;
  }

  async function consent(cookie: string, authorizeRes: Response, accept = true) {
    const location = await redirectOf(authorizeRes);
    expect(location).toContain("/oauth/consent");
    const query = new URL(location, t.base).search.slice(1);
    const res = await fetch(`${t.base}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: t.base },
      body: JSON.stringify({ accept, oauth_query: query }),
    });
    return (await res.json()) as { url?: string; redirect_uri?: string };
  }

  async function exchange(
    clientId: string,
    code: string,
    verifier: string,
    extra: Record<string, string> = {},
  ) {
    const res = await fetch(`${t.base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource,
        ...extra,
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function fullFlow(cookie: string, scope?: string) {
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();
    const auth = await authorize(cookie, client_id, { challenge, scope });
    const done = await consent(cookie, auth);
    const callback = new URL((done.url ?? done.redirect_uri) as string);
    const code = callback.searchParams.get("code") as string;
    expect(callback.searchParams.get("state")).toBe("state-1");
    const token = await exchange(client_id, code, verifier);
    return { clientId: client_id, verifier, code, token };
  }

  it("serves protected resource and authorization server metadata", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await fetch(`${t.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const prm = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(prm.resource).toBe(resource);
      expect(prm.authorization_servers).toEqual([`${t.base}/api/auth`]);
    }
    const as = await fetch(`${t.base}/.well-known/oauth-authorization-server/api/auth`);
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(`${t.base}/api/auth`);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(String(meta.token_endpoint)).toContain("/oauth2/token");
    expect(String(meta.registration_endpoint)).toContain("/oauth2/register");
  });

  it("answers unauthenticated /mcp with an actionable Bearer challenge", async () => {
    const res = await fetch(`${t.base}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${t.base}/.well-known/oauth-protected-resource/mcp"`);
    // Clients ask for the challenged scope: it must include write and a refresh token.
    expect(challenge).toContain('scope="studix:read studix:write offline_access"');
    expect(challenge).not.toContain("error=");

    const bad = await fetch(`${t.base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("runs authorization code + PKCE and the token works on /mcp", async () => {
    const cookie = await t.signUp(`oauth-a-${Date.now()}@example.test`);
    const { token } = await fullFlow(cookie);
    expect(token.status).toBe(200);
    const access = token.body.access_token as string;
    expect(access.split(".")).toHaveLength(3);
    expect(token.body.refresh_token).toBeTruthy();

    const client = await t.connect(access);
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name)).toContain("studix_inspect");
    const inspected = await client.callTool({ name: "studix_inspect", arguments: {} });
    expect(inspected.isError).not.toBe(true);
  });

  it("rejects a reused code, a wrong PKCE verifier and a missing resource", async () => {
    const cookie = await t.signUp(`oauth-b-${Date.now()}@example.test`);
    const { clientId, verifier, code } = await fullFlow(cookie);
    expect((await exchange(clientId, code, verifier)).status).toBeGreaterThanOrEqual(400);

    const { client_id } = await registerClient();
    const { challenge } = pkce();
    const done = await consent(cookie, await authorize(cookie, client_id, { challenge }));
    const code2 = new URL((done.url ?? done.redirect_uri) as string).searchParams.get("code") as string;
    const wrong = await exchange(client_id, code2, b64url(randomBytes(32)));
    expect(wrong.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses an unknown resource and a mismatched redirect uri", async () => {
    const cookie = await t.signUp(`oauth-c-${Date.now()}@example.test`);
    const { client_id } = await registerClient();
    const { challenge } = pkce();
    const otherResource = await authorize(cookie, client_id, {
      challenge,
      resource: "https://evil.example/mcp",
    });
    expect(await redirectOf(otherResource)).not.toContain("/oauth/consent");
    const redirect = await authorize(cookie, client_id, { challenge, redirect: "http://127.0.0.1:9/other" });
    const redirected = await redirectOf(redirect);
    expect(redirected).not.toContain("code=");
    expect(redirected).not.toContain("/oauth/consent");
  });

  it("does not expose opaque tokens: a token minted without resource is refused at /mcp", async () => {
    const cookie = await t.signUp(`oauth-d-${Date.now()}@example.test`);
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();
    const done = await consent(cookie, await authorize(cookie, client_id, { challenge, resource: null }));
    const code = new URL((done.url ?? done.redirect_uri) as string).searchParams.get("code") as string;
    const res = await fetch(`${t.base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    });
    const body = (await res.json()) as { access_token?: string };
    // Either the server refuses to mint a token without a resource, or the token it mints is not accepted.
    if (res.status === 200) {
      expect(body.access_token).toBeTruthy();
      const mcp = await fetch(`${t.base}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      expect(mcp.status).toBe(401);
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("limits a token to the scopes consented and answers 403 insufficient_scope without studix:read", async () => {
    const cookie = await t.signUp(`oauth-e-${Date.now()}@example.test`);
    const readOnly = await fullFlow(cookie, "studix:read");
    expect(String(readOnly.token.body.scope)).not.toContain("studix:write");
    const client = await t.connect(readOnly.token.body.access_token as string);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    const writeOnly = await fullFlow(cookie, "studix:write");
    const res = await fetch(`${t.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${writeOnly.token.body.access_token}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("revoking a connection stops the token at once and refresh no longer works", async () => {
    const cookie = await t.signUp(`oauth-f-${Date.now()}@example.test`);
    const { token, clientId } = await fullFlow(cookie);
    const access = token.body.access_token as string;
    const ok = await fetch(`${t.base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(ok.status).toBe(200);

    const list = await t.api("GET", "/api/oauth/connections", { cookie });
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: { id: string; clientName: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.clientName).toBe("Test Agent");

    const del = await t.api("DELETE", `/api/oauth/connections/${items[0]?.id}`, { cookie });
    expect(del.status).toBe(200);
    const after = await fetch(`${t.base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(after.status).toBe(401);

    const refresh = await fetch(`${t.base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.body.refresh_token as string,
        client_id: clientId,
        resource,
      }),
    });
    expect(refresh.status).toBeGreaterThanOrEqual(400);
  });

  it("another user cannot list or revoke a connection", async () => {
    const cookieA = await t.signUp(`oauth-g-${Date.now()}@example.test`);
    const cookieB = await t.signUp(`oauth-h-${Date.now()}@example.test`);
    await fullFlow(cookieA);
    const mine = (
      (await (await t.api("GET", "/api/oauth/connections", { cookie: cookieA })).json()) as {
        items: { id: string }[];
      }
    ).items;
    const theirs = (
      (await (await t.api("GET", "/api/oauth/connections", { cookie: cookieB })).json()) as {
        items: unknown[];
      }
    ).items;
    expect(theirs).toHaveLength(0);
    const del = await t.api("DELETE", `/api/oauth/connections/${mine[0]?.id}`, { cookie: cookieB });
    expect(del.status).toBe(404);
  });

  it("stops a token when the user leaves the workspace (cross-tenant)", async () => {
    const cookie = await t.signUp(`oauth-i-${Date.now()}@example.test`);
    const { token, clientId } = await fullFlow(cookie);
    const [consentRow] = await t.db.client`select user_id from oauth_consents where client_id = ${clientId}`;
    await t.db.client`delete from members where user_id = ${consentRow?.user_id as string}`;
    const res = await fetch(`${t.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.body.access_token}` },
    });
    expect(res.status).toBe(401);
  });

  it("keeps stx_ API keys working unchanged", async () => {
    const ctx = await t.provisionTenant("oauth-keys");
    const key = await t.createKey(ctx);
    const client = await t.connect(key);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const bad = await fetch(`${t.base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer stx_test_deadbeef" },
    });
    expect(bad.status).toBe(401);
  });

  it("answers the token endpoint preflight for browser clients without credentials", async () => {
    const res = await fetch(`${t.base}/api/auth/oauth2/token`, {
      method: "OPTIONS",
      headers: { origin: "https://inspector.example", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  describe("access token verification", () => {
    const issuer = () => `${t.base}/api/auth`;

    async function verifier() {
      const { publicKey, privateKey } = await generateKeyPair("ES256");
      const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
      const oauth = createMcpOAuth({
        db: t.db.db,
        directory: t.db.repos.directory,
        resource,
        issuer: issuer(),
        jwks: async () => ({ keys: [jwk] }),
        serverMetadata: async () => new Response("{}"),
      });
      return { oauth, privateKey };
    }

    async function grantRow() {
      const cookie = await t.signUp(
        `oauth-v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`,
      );
      const { clientId } = await fullFlow(cookie);
      const [row] = await t.db.client`
        select user_id, reference_id from oauth_consents where client_id = ${clientId} limit 1`;
      return { clientId, userId: row?.user_id as string, workspaceId: row?.reference_id as string };
    }

    function mint(
      key: CryptoKey,
      claims: { sub: string; azp: string; workspace_id: string; scope?: string },
      options: { iss?: string; aud?: string; exp?: number | string } = {},
    ) {
      return new SignJWT({ ...claims, scope: claims.scope ?? "studix:read" })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(options.iss ?? issuer())
        .setAudience(options.aud ?? resource)
        .setIssuedAt()
        .setExpirationTime(options.exp ?? "5m")
        .sign(key);
    }

    it("accepts a valid token and maps it to the tenant with an oauth actor", async () => {
      const { oauth, privateKey } = await verifier();
      const g = await grantRow();
      const ctx = await oauth.authenticate(
        `Bearer ${await mint(privateKey, { sub: g.userId, azp: g.clientId, workspace_id: g.workspaceId })}`,
      );
      expect(ctx.workspaceId).toBe(g.workspaceId);
      expect(ctx.actor.type).toBe("oauth");
      expect(ctx.actor.type === "oauth" && ctx.actor.scopes).toContain("project:read");
      expect(ctx.actor.type === "oauth" && ctx.actor.scopes).not.toContain("project:write");
    });

    it("rejects wrong issuer, wrong audience, expired, foreign signature and a workspace the user is not in", async () => {
      const { oauth, privateKey } = await verifier();
      const other = await generateKeyPair("ES256");
      const g = await grantRow();
      const claims = { sub: g.userId, azp: g.clientId, workspace_id: g.workspaceId };
      const bad = {
        issuer: await mint(privateKey, claims, { iss: "https://evil.example/api/auth" }),
        audience: await mint(privateKey, claims, { aud: "https://other.example/mcp" }),
        expired: await mint(privateKey, claims, { exp: Math.floor(Date.now() / 1000) - 3600 }),
        signature: await mint(other.privateKey, claims),
        workspace: await mint(privateKey, { ...claims, workspace_id: "wsp_not_mine" }),
        client: await mint(privateKey, { ...claims, azp: "unknown-client" }),
      };
      for (const [name, token] of Object.entries(bad)) {
        await expect(oauth.authenticate(`Bearer ${token}`), name).rejects.toMatchObject({
          failure: "invalid_token",
        });
      }
      await expect(oauth.authenticate(`Bearer ${bad.issuer}`)).rejects.toBeInstanceOf(McpTokenError);
    });

    it("refuses a token minted before the current consent (revoke then reconnect)", async () => {
      const { oauth, privateKey } = await verifier();
      const g = await grantRow();
      const claims = { sub: g.userId, azp: g.clientId, workspace_id: g.workspaceId };
      const token = await mint(privateKey, claims);
      await expect(oauth.authenticate(`Bearer ${token}`)).resolves.toBeTruthy();
      await t.db
        .client`update oauth_consents set created_at = now() + interval '1 hour' where client_id = ${g.clientId}`;
      await expect(oauth.authenticate(`Bearer ${token}`)).rejects.toMatchObject({ failure: "invalid_token" });
    });

    it("reports insufficient_scope when the token lacks studix:read", async () => {
      const { oauth, privateKey } = await verifier();
      const g = await grantRow();
      const token = await mint(privateKey, {
        sub: g.userId,
        azp: g.clientId,
        workspace_id: g.workspaceId,
        scope: "offline_access",
      });
      await expect(oauth.authenticate(`Bearer ${token}`)).rejects.toMatchObject({
        failure: "insufficient_scope",
      });
    });

    it("never grants more than the consent covers, even if the token claims it", async () => {
      const { oauth, privateKey } = await verifier();
      const g = await grantRow();
      const ctx = await oauth.authenticate(
        `Bearer ${await mint(privateKey, {
          sub: g.userId,
          azp: g.clientId,
          workspace_id: g.workspaceId,
          scope: "studix:read studix:write",
        })}`,
      );
      // fullFlow consented to read+write, so write is allowed here; narrow the consent and retry.
      expect(ctx.actor.type === "oauth" && ctx.actor.scopes).toContain("project:write");
      await t.db
        .client`update oauth_consents set scopes = ${["studix:read"]} where client_id = ${g.clientId}`;
      const narrowed = await oauth.authenticate(
        `Bearer ${await mint(privateKey, {
          sub: g.userId,
          azp: g.clientId,
          workspace_id: g.workspaceId,
          scope: "studix:read studix:write",
        })}`,
      );
      expect(narrowed.actor.type === "oauth" && narrowed.actor.scopes).not.toContain("project:write");
    });
  });
});
