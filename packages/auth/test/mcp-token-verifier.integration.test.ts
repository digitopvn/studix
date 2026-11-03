import { schema } from "@studix/database";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { newId } from "@studix/shared";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createMcpTokenVerifier,
  effectivePermissions,
  type McpTokenVerifier,
  WORKSPACE_CLAIM,
} from "../src/mcp-oauth.ts";

const actorScopes = (actor: unknown) => (actor as { scopes: readonly string[] }).scopes;

const ISSUER = "https://app.studix.test/api/auth";
const RESOURCE = "https://app.studix.test/mcp";
const db = withTestDatabase();

interface Grant {
  userId: string;
  workspaceId: string;
  organizationId: string;
  clientId: string;
}

let signer: CryptoKey;
let verifier: McpTokenVerifier;
let rotated: { signer: CryptoKey; jwks: JSONWebKeySet } | undefined;
let jwksServed: JSONWebKeySet;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  signer = pair.privateKey;
  jwksServed = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }] };
  verifier = createMcpTokenVerifier({
    db: db.current.db,
    directory: db.current.repos.directory,
    resource: RESOURCE,
    issuer: ISSUER,
    jwks: async () => jwksServed,
  });
});

async function grant(
  role: "owner" | "viewer" = "owner",
  scopes = ["studix:read", "studix:write"],
): Promise<Grant> {
  const userId = newId("usr");
  await insertTestUser(db.current, { id: userId, email: `${userId}@example.test` });
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: "Org", slug: `org-${userId.slice(-10)}` },
    workspace: { name: "Main", slug: "main" },
    ownerUserId: userId,
  });
  if (role !== "owner") {
    await db.current.db.update(schema.members).set({ role }).where(eq(schema.members.userId, userId));
  }
  const clientId = `client-${userId.slice(-8)}`;
  await db.current.db.insert(schema.oauthClients).values({
    id: newId("ocl"),
    clientId,
    redirectUris: ["http://127.0.0.1/cb"],
  });
  await db.current.db.insert(schema.oauthConsents).values({
    id: newId("ocn"),
    clientId,
    userId,
    referenceId: workspace.id,
    scopes,
  });
  return { userId, workspaceId: workspace.id, organizationId: organization.id, clientId };
}

async function token(
  g: Grant,
  overrides: {
    claims?: Record<string, unknown>;
    iss?: string;
    aud?: string;
    exp?: string;
    key?: CryptoKey;
    kid?: string;
    typ?: string;
  } = {},
) {
  return new SignJWT({
    azp: g.clientId,
    scope: "studix:read studix:write",
    [WORKSPACE_CLAIM]: g.workspaceId,
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: overrides.kid ?? "k1", typ: overrides.typ ?? "at+jwt" })
    .setSubject(g.userId)
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? RESOURCE)
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(overrides.key ?? signer);
}

describe("MCP OAuth access token verification", () => {
  it("maps a valid token to the user's workspace with the granted scopes", async () => {
    const g = await grant();
    const ctx = await verifier.authenticate(await token(g));
    expect(ctx).toMatchObject({ workspaceId: g.workspaceId, organizationId: g.organizationId });
    expect(ctx.actor).toMatchObject({ type: "oauth", id: g.userId, clientId: g.clientId });
    // An owner holding studix:write is held to the editor set: no key or member administration.
    expect(actorScopes(ctx.actor)).toContain("project:write");
    expect(actorScopes(ctx.actor)).not.toContain("apikey:manage");
  });

  it("rejects the wrong issuer, wrong audience, expired and foreign-signed tokens", async () => {
    const g = await grant();
    await expect(
      verifier.authenticate(await token(g, { iss: "https://evil.test/api/auth" })),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      verifier.authenticate(await token(g, { aud: "https://other.test/mcp" })),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(verifier.authenticate(await token(g, { exp: "-1m" as never }))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const foreign = await generateKeyPair("EdDSA");
    await expect(verifier.authenticate(await token(g, { key: foreign.privateKey }))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(verifier.authenticate("garbage")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects tokens that are not access tokens or whose client was disabled", async () => {
    const g = await grant();
    await expect(verifier.authenticate(await token(g, { typ: "JWT" }))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(verifier.authenticate(await token(g))).resolves.toBeDefined();
    await db.current.db
      .update(schema.oauthClients)
      .set({ disabled: true })
      .where(eq(schema.oauthClients.clientId, g.clientId));
    await expect(verifier.authenticate(await token(g))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a token without a workspace, client or subject binding", async () => {
    const g = await grant();
    await expect(
      verifier.authenticate(await token(g, { claims: { [WORKSPACE_CLAIM]: undefined } })),
    ).rejects.toThrow();
    await expect(verifier.authenticate(await token(g, { claims: { azp: undefined } }))).rejects.toThrow();
  });

  it("rejects another workspace, even one the user does not belong to", async () => {
    const g = await grant();
    const other = await grant();
    await expect(
      verifier.authenticate(await token(g, { claims: { [WORKSPACE_CLAIM]: other.workspaceId } })),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a token once the grant is gone or the membership ends", async () => {
    const revoked = await grant();
    const revokedToken = await token(revoked);
    await verifier.authenticate(revokedToken);
    await db.current.client`delete from oauth_consents where user_id = ${revoked.userId}`;
    await expect(verifier.authenticate(revokedToken)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    const removed = await grant();
    const removedToken = await token(removed);
    await db.current.client`delete from members where user_id = ${removed.userId}`;
    await expect(verifier.authenticate(removedToken)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("never grants more than the consent holds or the role allows", async () => {
    const narrowed = await grant("owner", ["studix:read"]);
    const ctx = await verifier.authenticate(await token(narrowed));
    expect(ctx.scopes).toEqual(["studix:read"]);
    expect(actorScopes(ctx.actor)).not.toContain("project:write");

    const viewer = await grant("viewer");
    const viewerCtx = await verifier.authenticate(await token(viewer));
    expect(actorScopes(viewerCtx.actor)).not.toContain("project:write");
    expect(actorScopes(viewerCtx.actor)).toContain("project:read");
  });

  it("picks up a rotated signing key without a restart", async () => {
    const g = await grant();
    const pair = await generateKeyPair("EdDSA", { extractable: true });
    rotated = {
      signer: pair.privateKey,
      jwks: {
        keys: [
          ...jwksServed.keys,
          { ...(await exportJWK(pair.publicKey)), kid: "k2", alg: "EdDSA", use: "sig" },
        ],
      },
    };
    jwksServed = rotated.jwks;
    const ctx = await verifier.authenticate(await token(g, { key: rotated.signer, kid: "k2" }));
    expect(ctx.workspaceId).toBe(g.workspaceId);
  });
});

describe("effectivePermissions", () => {
  it("is the scope set intersected with the role, and offline_access carries none", () => {
    expect(effectivePermissions(["offline_access"], "owner")).toEqual([]);
    expect(effectivePermissions(["studix:read"], "reviewer")).toEqual(
      expect.arrayContaining(["workspace:read", "project:read", "asset:read"]),
    );
    expect(effectivePermissions(["studix:write"], "viewer")).toEqual(
      expect.arrayContaining(["project:read"]),
    );
    expect(effectivePermissions(["studix:write"], "viewer")).not.toContain("project:write");
    expect(effectivePermissions(["studix:write"], "owner")).not.toContain("apikey:manage");
  });
});
