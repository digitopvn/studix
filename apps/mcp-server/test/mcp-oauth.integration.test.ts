import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@modelcontextprotocol/client";
import { WORKSPACE_CLAIM } from "@studix/auth";
import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

const REDIRECT = "http://127.0.0.1:9999/cb";
const MCP_ACCEPT = "application/json, text/event-stream";

interface Envelope {
  status: "ok" | "error";
  error?: { code: string };
}

let app: TestApp;
let resource: string;
let issuer: string;

beforeAll(async () => {
  app = await startTestApp({ rateLimits: { auth: { capacity: 10_000, refillPerSecond: 1000 } } });
  resource = `${app.base}/mcp`;
  issuer = `${app.base}/api/auth`;
});
afterAll(async () => {
  await app.close();
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${app.base}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Connector",
      application_type: "native",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "studix:read studix:write offline_access",
      ...overrides,
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Ask the authorization endpoint for a code the way a browser would, as the signed-in user in `cookie`. */
async function authorize(
  cookie: string,
  clientId: string,
  options: { scope?: string; challenge: string; state?: string; resource?: string; redirectUri?: string },
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: options.redirectUri ?? REDIRECT,
    scope: options.scope ?? "studix:read studix:write offline_access",
    state: options.state ?? "state-1",
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    resource: options.resource ?? resource,
  });
  const res = await fetch(`${app.base}/api/auth/oauth2/authorize?${query}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const body = (await res.json()) as { redirect?: boolean; url?: string };
  return { status: res.status, location: body.url ?? res.headers.get("location") ?? "" };
}

async function consent(cookie: string, location: string, accept = true) {
  const oauthQuery = location.slice(location.indexOf("?") + 1);
  const res = await fetch(`${app.base}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: app.base },
    body: JSON.stringify({ accept, oauth_query: oauthQuery }),
  });
  const body = (await res.json()) as { url?: string };
  return { status: res.status, url: body.url ?? "" };
}

async function exchange(params: Record<string, string>) {
  const res = await fetch(`${app.base}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** Sign up, register, authorize and consent; returns the token response. */
async function connect(
  email: string,
  options: { scope?: string; cookie?: string; workspaceId?: string } = {},
) {
  const cookie = options.cookie ?? (await app.signUp(email));
  const registered = await registerClient();
  const clientId = registered.body.client_id as string;
  const { verifier, challenge } = pkce();
  const auth = await authorize(cookie, clientId, { challenge, scope: options.scope });
  let location = auth.location;
  if (location.startsWith("/oauth/workspace")) {
    const picked = await app.api("POST", "/api/mcp-oauth/workspace", {
      cookie,
      body: { workspaceId: options.workspaceId },
    });
    expect(picked.status).toBe(204);
    const cont = await fetch(`${app.base}/api/auth/oauth2/continue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: app.base },
      body: JSON.stringify({ postLogin: true, oauth_query: location.slice(location.indexOf("?") + 1) }),
    });
    location = ((await cont.json()) as { url: string }).url;
  }
  expect(location.startsWith("/oauth/consent")).toBe(true);
  const granted = await consent(cookie, location);
  expect(granted.url.startsWith(REDIRECT)).toBe(true);
  const code = new URL(granted.url).searchParams.get("code") as string;
  expect(new URL(granted.url).searchParams.get("state")).toBe("state-1");
  const token = await exchange({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    resource,
  });
  return { cookie, clientId, token };
}

async function rpc(
  token: string | undefined,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
) {
  return fetch(`${app.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: MCP_ACCEPT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  return result.structuredContent as unknown as Envelope;
}

describe("MCP OAuth discovery", () => {
  it("publishes protected resource metadata at the root and path-specific URLs", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const res = await fetch(`${app.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toMatchObject({
        resource,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: expect.arrayContaining(["studix:read", "studix:write"]),
      });
    }
  });

  it("publishes authorization server metadata for PKCE S256 with a registration strategy", async () => {
    const res = await fetch(`${app.base}/.well-known/oauth-authorization-server/api/auth`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      jwks_uri: `${issuer}/jwks`,
      registration_endpoint: `${issuer}/oauth2/register`,
      client_id_metadata_document_supported: true,
    });
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    // The signing keys the metadata points to are served.
    const jwks = (await (await fetch(meta.jwks_uri as string)).json()) as { keys: unknown[] };
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it("answers an unauthenticated /mcp with an actionable challenge, and a bad token with invalid_token", async () => {
    const missing = await rpc(undefined);
    expect(missing.status).toBe(401);
    const challenge = missing.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${app.base}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="studix:read studix:write"');
    expect(challenge).not.toContain("error=");

    const bad = await rpc("not.a.jwt");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await bad.text()).not.toContain("not.a.jwt");
  });

  it("lets a browser-based client call the token endpoint cross-origin without credentials", async () => {
    const preflight = await fetch(`${app.base}/api/auth/oauth2/token`, {
      method: "OPTIONS",
      headers: { origin: "https://client.example", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("MCP OAuth authorization code flow", () => {
  it("issues a resource-bound token that works on /mcp next to stx_ keys", async () => {
    const { token, clientId } = await connect("flow@example.test");
    expect(token.status).toBe(200);
    expect(token.body.token_type?.toLowerCase()).toBe("bearer");
    expect(token.body.refresh_token).toBeTruthy();

    const claims = JSON.parse(
      Buffer.from(token.body.access_token?.split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims).toMatchObject({ iss: issuer, aud: resource, azp: clientId });
    expect(claims[WORKSPACE_CLAIM]).toBeTruthy();

    const { Client: McpClient, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new McpClient({ name: "oauth-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token.body.access_token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("studix_inspect");
      expect((await call(client, "studix_inspect")).status).toBe("ok");
    } finally {
      await client.close();
    }

    // The existing API-key path is untouched.
    const keyed = await app.connect(await app.createKey(await app.provisionTenant("keyed")));
    expect((await call(keyed, "studix_inspect")).status).toBe("ok");
  });

  it("limits a token to the scopes the user granted, intersected with their role", async () => {
    const { token } = await connect("readonly@example.test", { scope: "studix:read" });
    const { Client: McpClient, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new McpClient({ name: "oauth-read", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token.body.access_token}` } },
      }),
    );
    try {
      expect((await call(client, "studix_inspect")).status).toBe("ok");
      const cancel = await call(client, "studix_cancel_job", { jobId: "job_missing" });
      expect(cancel.status).toBe("error");
      expect(cancel.error?.code).toBe("FORBIDDEN");
    } finally {
      await client.close();
    }
  });

  it("rotates refresh tokens and keeps the workspace binding", async () => {
    const { token, clientId } = await connect("refresh@example.test");
    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token as string,
      client_id: clientId,
      resource,
    });
    expect(refreshed.status).toBe(200);
    expect((await rpc(refreshed.body.access_token)).status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(token.body.refresh_token);
  });

  it("stops accepting a token the moment the user revokes the connection", async () => {
    const { token, cookie } = await connect("revoke@example.test");
    expect((await rpc(token.body.access_token)).status).toBe(200);

    const listed = await app.api("GET", "/api/mcp-oauth/connections", { cookie });
    const { connections } = (await listed.json()) as { connections: { id: string; clientName: string }[] };
    expect(connections).toHaveLength(1);
    expect(connections[0]?.clientName).toBe("Test Connector");

    expect(
      (await app.api("DELETE", `/api/mcp-oauth/connections/${connections[0]?.id}`, { cookie })).status,
    ).toBe(204);
    const after = await rpc(token.body.access_token);
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // The refresh token died with the grant.
    const again = await exchange({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token as string,
      client_id: connections[0]
        ? (await app.db.client`select client_id from oauth_clients limit 1`)[0]?.client_id
        : "",
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("only lets a user revoke their own connections", async () => {
    const owner = await connect("owner-conn@example.test");
    const other = await app.signUp("intruder@example.test");
    const listed = await app.api("GET", "/api/mcp-oauth/connections", { cookie: owner.cookie });
    const [mine] = ((await listed.json()) as { connections: { id: string }[] }).connections;
    expect(
      (await app.api("DELETE", `/api/mcp-oauth/connections/${mine?.id}`, { cookie: other })).status,
    ).toBe(404);
    expect((await rpc(owner.token.body.access_token)).status).toBe(200);
  });

  it("ends access when the user leaves the workspace", async () => {
    const { token, cookie } = await connect("leaver@example.test");
    expect((await rpc(token.body.access_token)).status).toBe(200);
    await app.db
      .client`delete from members where user_id = (select id from users where email = 'leaver@example.test')`;
    expect((await rpc(token.body.access_token)).status).toBe(401);
    expect(cookie).toBeTruthy();
  });

  it("asks a user with several workspaces to choose one, and binds the grant to it", async () => {
    const cookie = await app.signUp("multi@example.test");
    const me = (await (await app.api("GET", "/api/me", { cookie })).json()) as { user: { id: string } };
    const { organization, workspace } = await app.db.repos.directory.provisionWorkspace({
      organization: { name: "Second", slug: `second-${randomBytes(4).toString("hex")}` },
      workspace: { name: "Second", slug: "second" },
      ownerUserId: me.user.id,
    });
    expect(organization.id).toBeTruthy();

    const { clientId } = await (async () => {
      const registered = await registerClient();
      return { clientId: registered.body.client_id as string };
    })();
    const { challenge } = pkce();
    const auth = await authorize(cookie, clientId, { challenge });
    expect(auth.location.startsWith("/oauth/workspace")).toBe(true);

    // A workspace the user does not belong to cannot be picked.
    const stranger = await app.provisionTenant("stranger");
    const refused = await app.api("POST", "/api/mcp-oauth/workspace", {
      cookie,
      body: { workspaceId: stranger.workspaceId },
    });
    expect(refused.status).toBe(403);

    const { token } = await connect("multi@example.test", { cookie, workspaceId: workspace.id });
    const claims = JSON.parse(
      Buffer.from(token.body.access_token?.split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims[WORKSPACE_CLAIM]).toBe(workspace.id);
  });
});

describe("MCP OAuth rejections", () => {
  it("rejects an unregistered redirect URI, a wrong PKCE verifier and a replayed code", async () => {
    const cookie = await app.signUp("rejects@example.test");
    const registered = await registerClient();
    const clientId = registered.body.client_id as string;
    const { challenge } = pkce();

    const mismatch = await authorize(cookie, clientId, {
      challenge,
      redirectUri: "http://127.0.0.1:9999/other",
    });
    expect(mismatch.location).not.toContain("code=");
    expect(mismatch.location.startsWith("http://127.0.0.1:9999/")).toBe(false);

    const ok = await authorize(cookie, clientId, { challenge });
    const granted = await consent(cookie, ok.location);
    const code = new URL(granted.url).searchParams.get("code") as string;
    const wrongVerifier = await exchange({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: randomBytes(32).toString("base64url"),
      resource,
    });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.access_token).toBeUndefined();

    // The code is spent after one use, correct verifier or not.
    const replay = await exchange({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: randomBytes(32).toString("base64url"),
      resource,
    });
    expect(replay.status).toBe(400);
  });

  it("refuses plain PKCE and a resource other than this server's", async () => {
    const cookie = await app.signUp("plain@example.test");
    const clientId = (await registerClient()).body.client_id as string;
    const plain = await fetch(
      `${app.base}/api/auth/oauth2/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "studix:read",
        code_challenge: "x".repeat(43),
        code_challenge_method: "plain",
        resource,
      })}`,
      { headers: { cookie }, redirect: "manual" },
    );
    expect(JSON.stringify(await plain.text())).not.toContain("/oauth/consent");

    const elsewhere = await authorize(cookie, clientId, {
      challenge: pkce().challenge,
      resource: "https://other.example/mcp",
    });
    expect(elsewhere.location).not.toContain("/oauth/consent");
  });

  it("registers only public clients for this resource with known scopes", async () => {
    const wrongResource = await registerClient({ resources: ["https://other.example/mcp"] });
    expect(wrongResource.status).toBe(400);
    const unknownScope = await registerClient({ scope: "studix:admin" });
    expect(unknownScope.status).toBe(400);
    const web = await registerClient({
      application_type: "web",
      redirect_uris: ["http://evil.example/cb"],
    });
    expect(web.status).toBe(400);
  });

  it("refuses confidential clients and oversized registration documents", async () => {
    const confidential = await registerClient({ token_endpoint_auth_method: "client_secret_post" });
    expect(confidential.status).toBe(400);
    expect(confidential.body.client_secret).toBeUndefined();
    expect((await registerClient({ client_name: "x".repeat(101) })).status).toBe(400);
    expect(
      (await registerClient({ redirect_uris: Array.from({ length: 11 }, (_, i) => `${REDIRECT}${i}`) }))
        .status,
    ).toBe(400);
  });

  it("does not let a dashboard session mint a JWT through the signing plugin", async () => {
    const cookie = await app.signUp("jwt-endpoint@example.test");
    const res = await fetch(`${app.base}/api/auth/token`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  describe("tokens the server did not issue", () => {
    /** Issuer, audience and expiry checks are covered in packages/auth; here a foreign key must fail on /mcp. */
    async function forged(
      claims: Record<string, unknown>,
      options: { iss?: string; aud?: string; exp?: string } = {},
    ) {
      const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(options.iss ?? issuer)
        .setAudience(options.aud ?? resource)
        .setIssuedAt()
        .setExpirationTime(options.exp ?? "5m")
        .sign(privateKey);
    }

    it("never accepts a token whose signature the server did not make", async () => {
      const tenant = await app.provisionTenant("forged");
      const token = await forged({
        sub: tenant.actor.id,
        azp: "client",
        scope: "studix:read studix:write",
        [WORKSPACE_CLAIM]: tenant.workspaceId,
      });
      expect((await rpc(token)).status).toBe(401);
    });
  });

  it("applies a narrowed grant to tokens already issued", async () => {
    const { token } = await connect("narrow@example.test", { scope: "studix:read studix:write" });
    expect((await rpc(token.body.access_token)).status).toBe(200);
    await app.db
      .client`update oauth_consents set scopes = ARRAY['studix:read']::text[] where user_id = (select id from users where email = 'narrow@example.test')`;
    const { Client: McpClient, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new McpClient({ name: "oauth-narrow", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: `Bearer ${token.body.access_token}` } },
      }),
    );
    try {
      const cancel = await call(client, "studix_cancel_job", { jobId: "job_missing" });
      expect(cancel.error?.code).toBe("FORBIDDEN");
    } finally {
      await client.close();
    }
  });

  it("has no anonymous fallback and no secret in a rejection", async () => {
    const res = await rpc("eyJhbGciOiJFZERTQSJ9.e30.c2ln");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("c2ln");
    expect((await rpc(undefined)).status).toBe(401);
  });
});
